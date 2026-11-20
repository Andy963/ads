import { createHash } from "node:crypto";

import { normalizeUpstreamBaseUrl } from "../utils/upstreamUrl.js";
import { MAX_NATIVE_REQUEST_IMAGE_BYTES, NativeImageInputError } from "./nativeImages.js";
import type { NativeResponsesOutputItem } from "./nativeResponsesTypes.js";
import {
  NativeProviderError,
  readSseData,
  type NativeChatMessage,
  type NativeCompletionRequest,
  type NativeCompletionResult,
} from "./openAiCompatibleClient.js";

type JsonRecord = Record<string, unknown>;
type OutputPart = Extract<NativeResponsesOutputItem, { type: "message" }>["content"][number];
type ParseMode = "partial" | "completed" | "incomplete";

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRYABLE_CODES = new Set([
  "server_error", "internal_error", "internal_server_error", "rate_limit_exceeded", "rate_limit_error",
  "timeout", "request_timeout", "request_timeout_error", "service_unavailable", "overloaded_error",
]);

function malformed(detail: string): never {
  // Only static protocol descriptions belong here, never provider payloads or IDs.
  throw new NativeProviderError(`Native Responses upstream ${detail}`, { kind: "malformed" });
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed("returned an invalid object");
  return value as JsonRecord;
}

function string(value: unknown): string {
  if (typeof value !== "string") malformed("returned an invalid string");
  return value;
}

function identifier(value: unknown): string {
  const result = string(value);
  if (!result.trim() || result.trim() !== result) malformed("returned an invalid identifier");
  return result;
}

function index(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) malformed("returned an invalid index");
  return value;
}

export function getNativeResponsesScope(request: Pick<NativeCompletionRequest, "baseUrl" | "model" | "apiKey">): string {
  // A tuple avoids delimiter collisions; credentials never leave this hash operation.
  return createHash("sha256")
    .update(JSON.stringify([normalizeUpstreamBaseUrl(request.baseUrl), request.model, request.apiKey]))
    .digest("hex");
}

function parsePart(value: unknown): OutputPart {
  const part = record(value);
  if (part.type === "refusal") return { type: "refusal", refusal: string(part.refusal) };
  if (part.type !== "output_text") malformed("returned an unsupported message content type");
  if (part.annotations !== undefined && !Array.isArray(part.annotations)) malformed("returned invalid annotations");
  return { type: "output_text", text: string(part.text), annotations: part.annotations ?? [] };
}

function partText(part: OutputPart): string {
  return part.type === "output_text" ? part.text : part.refusal;
}

function parseItem(value: unknown, mode: ParseMode): NativeResponsesOutputItem {
  const item = record(value);
  const id = item.id === undefined ? undefined : identifier(item.id);
  if (item.type === "reasoning") {
    if (!id || !Array.isArray(item.summary)) malformed("returned invalid reasoning metadata");
    return {
      type: "reasoning", id,
      summary: item.summary.map(value => {
        const entry = record(value);
        if (entry.type !== "summary_text") malformed("returned an unsupported reasoning summary");
        return { type: "summary_text", text: string(entry.text) };
      }),
      ...(item.encrypted_content == null ? {} : { encrypted_content: string(item.encrypted_content) }),
    };
  }
  const status = item.status;
  if (status !== undefined && status !== "completed" && status !== "incomplete" && status !== "in_progress") {
    malformed("returned an invalid output status");
  }
  if (mode === "completed" && (status === "incomplete" || status === "in_progress")) {
    malformed("completed with unfinished output");
  }
  const metadata: { id?: string; status?: "completed" | "incomplete" } = {
    ...(id === undefined ? {} : { id }),
    ...(status === "completed" || status === "incomplete" ? { status } : {}),
  };
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) malformed("returned an invalid assistant message");
    if (item.phase != null && item.phase !== "commentary" && item.phase !== "final_answer") {
      malformed("returned an invalid assistant phase");
    }
    return {
      type: "message", role: "assistant", ...metadata,
      ...(item.phase == null ? {} : { phase: item.phase }),
      content: item.content.map(parsePart),
    };
  }
  if (item.type === "function_call") {
    const args = string(item.arguments);
    if (mode === "completed") {
      try {
        record(JSON.parse(args));
      } catch {
        malformed("returned malformed function arguments");
      }
    }
    return { type: "function_call", ...metadata, call_id: identifier(item.call_id), name: identifier(item.name), arguments: args };
  }
  return malformed("returned an unsupported output item type");
}

function parseOutput(value: unknown, mode: ParseMode): NativeResponsesOutputItem[] {
  if (!Array.isArray(value)) malformed("returned invalid output");
  const calls = new Set<string>();
  const ids = new Set<string>();
  return value.map(value => {
    const item = parseItem(value, mode);
    if (item.id) {
      if (ids.has(item.id)) malformed("returned duplicate output item IDs");
      ids.add(item.id);
    }
    if (item.type === "function_call") {
      if (calls.has(item.call_id)) malformed("returned duplicate function call IDs");
      calls.add(item.call_id);
    }
    return item;
  });
}

function canonicalText(message: NativeChatMessage): string {
  if (!Array.isArray(message.content)) return message.content ?? "";
  return message.content.map(part => {
    if (part.type !== "text") throw new NativeImageInputError("images are supported only in user or system messages.");
    return part.text;
  }).join("");
}

function replayOutput(message: NativeChatMessage, scope: string): NativeResponsesOutputItem[] | undefined {
  if (message.nativeResponses?.scope !== scope) return undefined;
  const output = parseOutput(message.nativeResponses.output, "incomplete");
  const text = output.flatMap(item => item.type === "message" ? item.content.map(partText) : []).join("");
  const calls = output.filter(item => item.type === "function_call");
  const canonicalCalls = message.tool_calls ?? [];
  // Credential redaction or transcript edits can invalidate an otherwise matching
  // scope. Canonical history is authoritative; never revive divergent sidecar calls.
  if (text !== canonicalText(message) || calls.length !== canonicalCalls.length
    || calls.some((call, position) => {
      const canonical = canonicalCalls[position];
      return canonical.type !== "function" || call.call_id !== canonical.id || call.name !== canonical.function.name
        || call.arguments !== canonical.function.arguments;
    })) return undefined;
  for (const call of calls) parseItem(call, "completed");
  return output;
}

async function buildRequestBody(request: NativeCompletionRequest, scope: string): Promise<JsonRecord> {
  const input: unknown[] = [];
  let imageBytes = 0;
  for (const message of request.messages) {
    request.signal?.throwIfAborted();
    if (message.role === "assistant") {
      const replay = replayOutput(message, scope);
      if (replay) {
        // Re-validate and allowlist replay too: transcripts are not wire envelopes.
        input.push(...replay);
      } else {
        const text = canonicalText(message);
        // Without an original output item, use the API's easy input-message form.
        if (text) input.push({ role: "assistant", content: text });
        for (const call of message.tool_calls ?? []) {
          input.push(parseItem({ type: "function_call", call_id: call.id, ...call.function }, "completed"));
        }
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: identifier(message.tool_call_id), output: canonicalText(message) });
    } else {
      const content: JsonRecord[] = [];
      for (const part of Array.isArray(message.content) ? message.content : [{ type: "text" as const, text: message.content ?? "" }]) {
        request.signal?.throwIfAborted();
        if (part.type === "text") {
          content.push({ type: "input_text", text: part.text });
        } else if (part.type === "image_url") {
          content.push({ type: "input_image", image_url: part.image_url.url });
        } else {
          if (!request.readImage) throw new NativeImageInputError("no image reader is available.");
          const bytes = await request.readImage(part);
          request.signal?.throwIfAborted();
          imageBytes += bytes.length;
          if (imageBytes > MAX_NATIVE_REQUEST_IMAGE_BYTES) {
            throw new NativeImageInputError("the request images exceed 50 MiB; use fewer or smaller images in a new conversation.");
          }
          content.push({ type: "input_image", image_url: `data:${part.mediaType};base64,${bytes.toString("base64")}` });
        }
      }
      input.push({ role: message.role, content });
    }
  }
  const body: JsonRecord = {
    model: request.model, input, stream: request.streaming !== false,
    store: false, include: ["reasoning.encrypted_content"],
    tool_choice: request.tools.length ? "auto" : "none",
  };
  if (request.tools.length) {
    body.tools = request.tools.map(tool => ({
      type: "function", name: tool.function.name, description: tool.function.description,
      parameters: tool.function.parameters, strict: false,
    }));
    if (request.options?.parallelToolCalls !== undefined) body.parallel_tool_calls = request.options.parallelToolCalls;
  }
  const options = request.options;
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.topP !== undefined) body.top_p = options.topP;
  if (options?.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options?.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };
  if (request.outputSchema != null) {
    const schema = typeof request.outputSchema === "object" && !Array.isArray(request.outputSchema)
      ? record(request.outputSchema) : undefined;
    let format: JsonRecord;
    if (schema?.type === "json_object") {
      format = { type: "json_object" };
    } else if (schema?.type === "json_schema") {
      const spec = record(schema.json_schema);
      format = {
        type: "json_schema", name: spec.name, schema: spec.schema,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        ...(spec.strict === undefined ? {} : { strict: spec.strict }),
      };
    } else {
      format = { type: "json_schema", name: "ads_output", strict: true, schema: request.outputSchema };
    }
    body.text = { format };
  }
  return body;
}

function providerFailure(value: unknown): never {
  const error = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const retryable = RETRYABLE_CODES.has(String(error.code)) || RETRYABLE_CODES.has(String(error.type))
    || (typeof error.status === "number" && RETRYABLE_HTTP.has(error.status));
  throw new NativeProviderError("Native Responses upstream failed [redacted]", { kind: retryable ? "transient" : "permanent" });
}

function parseUsage(value: unknown): NativeCompletionResult["usage"] {
  if (value == null) return null;
  const usage = record(value);
  const result: NonNullable<NativeCompletionResult["usage"]> = {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    if (usage[key] === undefined) continue;
    const count = usage[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) malformed("returned invalid token usage");
    result[key] = count;
  }
  return Object.keys(result).length ? result : null;
}

function parseTerminal(value: unknown, scope: string): NativeCompletionResult {
  const response = record(value);
  if (response.status === "failed" || response.error != null) providerFailure(response.error);
  if (response.status !== "completed" && response.status !== "incomplete") malformed("returned a nonterminal response");
  const incomplete = response.status === "incomplete";
  let finishReason = "stop";
  if (incomplete) {
    const reason = record(response.incomplete_details).reason;
    if (reason !== "max_output_tokens" && reason !== "content_filter") malformed("returned an unsupported incomplete reason");
    finishReason = reason === "max_output_tokens" ? "length" : "content_filter";
  }
  const output = parseOutput(response.output, incomplete ? "incomplete" : "completed");
  if (incomplete && output.some(item => item.type === "function_call")) {
    malformed("returned function calls in an incomplete response");
  }
  const toolCalls = output.flatMap(item => item.type === "function_call" ? [{
    id: item.call_id, type: "function" as const, function: { name: item.name, arguments: item.arguments },
  }] : []);
  return {
    text: output.flatMap(item => item.type === "message" ? item.content.map(partText) : []).join(""),
    toolCalls, finishReason: toolCalls.length ? "tool_calls" : finishReason,
    usage: parseUsage(response.usage),
    nativeResponses: { scope, output },
  };
}

interface StreamPart {
  type: OutputPart["type"];
  text: string;
  observed: boolean;
  done: boolean;
}

interface StreamItem {
  type: NativeResponsesOutputItem["type"];
  id?: string;
  callId?: string;
  name?: string;
  phase?: string;
  args: string;
  argsObserved: boolean;
  argsDone: boolean;
  parts: Map<number, StreamPart>;
  added: boolean;
  done: boolean;
}

class ResponseStream {
  private readonly items = new Map<number, StreamItem>();
  private text = "";
  private responseId?: string;

  constructor(private readonly request: NativeCompletionRequest, private readonly scope: string) {}

  private item(position: number, type: StreamItem["type"], id?: string): StreamItem {
    let state = this.items.get(position);
    if (!state) {
      state = { type, id, args: "", argsObserved: false, argsDone: false, parts: new Map(), added: false, done: false };
      this.items.set(position, state);
    }
    if (state.type !== type || (id !== undefined && state.id !== undefined && state.id !== id)) {
      malformed("returned conflicting streamed item identities");
    }
    if (id !== undefined) state.id = id;
    return state;
  }

  private match(state: StreamItem, item: NativeResponsesOutputItem): void {
    if (state.type !== item.type || (state.id !== undefined && state.id !== item.id)) malformed("changed a streamed item identity");
    if (item.type === "function_call") {
      if ((state.callId !== undefined && state.callId !== item.call_id) || (state.name !== undefined && state.name !== item.name)) {
        malformed("changed a streamed function identity");
      }
      if ((state.argsObserved || state.argsDone) && state.args !== item.arguments) malformed("changed streamed function arguments");
    } else if (item.type === "message") {
      if (state.phase !== undefined && state.phase !== item.phase) malformed("changed a streamed assistant phase");
      for (const [position, part] of state.parts) {
        const final = item.content[position];
        if (!final || final.type !== part.type || ((part.observed || part.done) && part.text !== partText(final))) {
          malformed("changed streamed message content");
        }
      }
      if (state.done && item.content.length !== state.parts.size) malformed("changed completed message content");
    }
  }

  private snapshot(event: JsonRecord, done: boolean): void {
    const output = parseItem(event.item, "partial");
    const state = this.item(index(event.output_index), output.type, output.id);
    if (state.done || (!done && state.added)) malformed("returned a duplicate output item event");
    this.match(state, output);
    state.added = true;
    state.done = done;
    if (output.type === "function_call") {
      state.callId = output.call_id;
      state.name = output.name;
      state.args = output.arguments;
      state.argsObserved ||= output.arguments.length > 0;
      state.argsDone = done;
    } else if (output.type === "message") {
      state.phase = output.phase;
      output.content.forEach((part, position) => {
        state.parts.set(position, { type: part.type, text: partText(part), observed: partText(part).length > 0, done });
      });
      this.publish();
    }
  }

  private publish(final?: string): void {
    const text = final ?? [...this.items.entries()].sort(([a], [b]) => a - b)
      .flatMap(([, item]) => [...item.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part.text)).join("");
    if (!text.startsWith(this.text)) malformed("returned non-append-only text");
    if (text !== this.text) {
      this.text = text;
      this.request.onTextDelta?.(text);
    }
  }

  consume(value: unknown): NativeCompletionResult | undefined {
    const event = record(value);
    const type = string(event.type);
    if (event.response_id !== undefined) this.checkResponseId(event.response_id);
    if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
      const response = record(event.response);
      if (response.id !== undefined) this.checkResponseId(response.id);
      if (response.status !== type.slice("response.".length)) malformed("returned conflicting terminal statuses");
      const result = parseTerminal(response, this.scope);
      // The terminal output must agree with every observed partial item.
      const output = parseOutput(response.output, response.status === "completed" ? "completed" : "incomplete");
      for (const [position, state] of this.items) {
        const item = output[position];
        if (!item) malformed("omitted streamed output from its terminal response");
        this.match(state, item);
      }
      this.publish(result.text);
      return result;
    }
    if (type === "error") providerFailure(event.error ?? event);
    if (["response.created", "response.in_progress", "response.queued"].includes(type)) {
      const response = record(event.response);
      if (response.id !== undefined) this.checkResponseId(response.id);
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      this.snapshot(event, type.endsWith(".done"));
      return;
    }
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const position = index(event.output_index);
      if (!this.items.has(position)) malformed("returned function arguments for an unknown item");
      const state = this.item(position, "function_call", identifier(event.item_id));
      if (state.done || state.argsDone) malformed("returned function arguments after completion");
      if (type.endsWith(".delta")) {
        state.args += string(event.delta);
        state.argsObserved = true;
      } else {
        const args = string(event.arguments);
        if (state.argsObserved && state.args !== args) malformed("changed streamed function arguments");
        state.args = args;
        state.argsDone = true;
      }
      if (event.name !== undefined && event.name !== state.name) malformed("changed a streamed function name");
      return;
    }
    const textEvent = /^response\.(output_text|refusal)\.(delta|done)$/.exec(type);
    const partEvent = type === "response.content_part.added" || type === "response.content_part.done";
    if (textEvent || partEvent) {
      const state = this.item(index(event.output_index), "message", identifier(event.item_id));
      if (state.done) malformed("returned content after item completion");
      const position = index(event.content_index);
      const snapshot = partEvent ? parsePart(event.part) : undefined;
      const partType = snapshot?.type ?? textEvent![1] as OutputPart["type"];
      let part = state.parts.get(position);
      if (!part) {
        part = { type: partType, text: "", observed: false, done: false };
        state.parts.set(position, part);
      }
      if (part.type !== partType) malformed("changed a streamed content type");
      const delta = textEvent?.[2] === "delta";
      if (delta) {
        if (part.done) malformed("returned text after content completion");
        part.text += string(event.delta);
        part.observed = true;
      } else {
        const text = snapshot ? partText(snapshot) : string(partType === "refusal" ? event.refusal : event.text);
        if ((part.observed || part.done) && part.text !== text) malformed("changed streamed message content");
        part.text = text;
        part.observed ||= text.length > 0;
        part.done ||= type.endsWith(".done");
      }
      this.publish();
      return;
    }
    // Reasoning stays in scoped replay only, never in assistant text or UI deltas.
    if (/^response\.reasoning_(summary_part|summary_text|text)\.(added|delta|done)$/.test(type)
      || type === "response.output_text.annotation.added") return;
    return malformed("returned an unsupported SSE event type");
  }

  private checkResponseId(value: unknown): void {
    const id = identifier(value);
    if (this.responseId !== undefined && this.responseId !== id) malformed("changed the streamed response identity");
    this.responseId = id;
  }
}

function rethrowTransport(error: unknown, request: NativeCompletionRequest, message: string): never {
  request.signal?.throwIfAborted();
  if (error instanceof NativeProviderError) throw error;
  if (error instanceof Error && (error.name === "AbortError" || error.message === "Aborted")) throw error;
  throw new NativeProviderError(message, { kind: "transient" });
}

async function readJson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<unknown> {
  const source = signal ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }) : body;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) return JSON.parse(text);
    }
  } finally {
    // Response.json() retains a locked reader on some failed fetch bodies.
    reader.releaseLock();
    await source.cancel().catch(() => {});
  }
}

async function parseResponse(response: Response, request: NativeCompletionRequest, scope: string): Promise<NativeCompletionResult> {
  if (!response.ok) {
    throw new NativeProviderError(`Native Responses upstream returned HTTP ${response.status} [redacted]`, {
      kind: RETRYABLE_HTTP.has(response.status) ? "transient" : "permanent", status: response.status,
    });
  }
  const sse = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  if (request.streaming === false) {
    if (sse) malformed("returned SSE for a non-streaming request");
    if (!response.body) malformed("returned an empty non-streaming response");
    let payload: unknown;
    try {
      payload = await readJson(response.body, request.signal);
    } catch (error) {
      if (error instanceof SyntaxError) malformed("returned malformed non-streaming JSON");
      rethrowTransport(error, request, "Native Responses upstream non-streaming response was interrupted");
    }
    request.signal?.throwIfAborted();
    return parseTerminal(payload, scope);
  }
  if (!sse || !response.body) malformed("returned a non-SSE response for a streaming request");
  // The abortable pipe also cancels pending reads from injected/custom fetch streams.
  const body = request.signal
    ? response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: request.signal })
    : response.body;
  try {
    const stream = new ResponseStream(request, scope);
    for await (const data of readSseData(body)) {
      request.signal?.throwIfAborted();
      if (data === "[DONE]") malformed("stream ended without a terminal response");
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        malformed("returned malformed SSE JSON");
      }
      const result = stream.consume(event);
      request.signal?.throwIfAborted();
      if (result) return result;
    }
    return malformed("stream ended without a terminal response");
  } catch (error) {
    rethrowTransport(error, request, "Native Responses upstream stream disconnected");
  } finally {
    // readSseData releases its reader before cancellation, including early returns.
    await body.cancel().catch(() => {});
  }
}

export async function completeNativeResponses(request: NativeCompletionRequest): Promise<NativeCompletionResult> {
  const baseUrl = normalizeUpstreamBaseUrl(request.baseUrl);
  const scope = getNativeResponsesScope(request);
  const body = JSON.stringify(await buildRequestBody(request, scope));
  request.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await (request.fetchImpl ?? fetch)(`${baseUrl}/responses`, {
      method: "POST", redirect: "error", signal: request.signal, body,
      headers: {
        Accept: request.streaming === false ? "application/json" : "text/event-stream",
        Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json",
      },
    });
  } catch (error) {
    rethrowTransport(error, request, "Native Responses upstream request failed");
  }
  try {
    request.signal?.throwIfAborted();
    return await parseResponse(response, request, scope);
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

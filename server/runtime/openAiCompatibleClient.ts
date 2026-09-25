import { buildChatCompletionsEndpoint } from "./upstreamEndpoint.js";

export type NativeChatRole = "system" | "user" | "assistant" | "tool";

export interface NativeChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface NativeChatMessage {
  role: NativeChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: NativeChatToolCall[];
}

export interface NativeToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface NativeCompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: NativeChatMessage[];
  tools: NativeToolDefinition[];
  streaming?: boolean;
  outputSchema?: unknown;
  options?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: string;
    supportsReasoningEffort?: boolean;
    parallelToolCalls?: boolean;
    includeUsage?: boolean;
  };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onTextDelta?: (text: string) => void;
}

export interface NativeCompletionResult {
  text: string;
  toolCalls: NativeChatToolCall[];
  finishReason?: string;
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
}

export type NativeProviderErrorKind = "transient" | "permanent" | "malformed";

export class NativeProviderError extends Error {
  readonly code = "NATIVE_PROVIDER_ERROR";
  readonly kind: NativeProviderErrorKind;
  readonly status?: number;

  constructor(message: string, options: { kind: NativeProviderErrorKind; status?: number; cause?: unknown }) {
    super(message);
    this.name = "NativeProviderError";
    this.kind = options.kind;
    this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

type JsonRecord = Record<string, unknown>;

const SUPPORTED_FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter"]);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseUsage(value: unknown): NativeCompletionResult["usage"] {
  const record = asRecord(value);
  if (!record) return null;
  const input = Number(record.prompt_tokens ?? record.input_tokens);
  const output = Number(record.completion_tokens ?? record.output_tokens);
  const total = Number(record.total_tokens);
  const usage = {
    input_tokens: Number.isFinite(input) ? input : undefined,
    output_tokens: Number.isFinite(output) ? output : undefined,
    total_tokens: Number.isFinite(total) ? total : undefined,
  };
  return usage.input_tokens !== undefined || usage.output_tokens !== undefined || usage.total_tokens !== undefined
    ? usage
    : null;
}

function buildRequestBody(request: NativeCompletionRequest): JsonRecord {
  const streaming = request.streaming !== false;
  const options = request.options;
  const body: JsonRecord = {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: "auto",
    stream: streaming,
  };
  if (streaming && options?.includeUsage !== false) body.stream_options = { include_usage: true };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.topP !== undefined) body.top_p = options.topP;
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options?.supportsReasoningEffort === true && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }
  if (options?.parallelToolCalls !== undefined) body.parallel_tool_calls = options.parallelToolCalls;
  if (request.outputSchema !== undefined && request.outputSchema !== null) {
    const schema = asRecord(request.outputSchema);
    body.response_format = schema && (schema.type === "json_schema" || schema.type === "json_object")
      ? request.outputSchema
      : {
          type: "json_schema",
          json_schema: {
            name: "ads_output",
            strict: true,
            schema: request.outputSchema,
          },
        };
  }
  return body;
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitBlock = (block: string): string | null => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    return data || null;
  };

  try {
    while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        const separatorLength = buffer[separator] === "\r" ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        const data = emitBlock(block);
        if (data) yield data;
        separator = buffer.search(/\r?\n\r?\n/);
      }
      if (next.done) break;
    }
    const final = emitBlock(buffer);
    if (final) yield final;
  } finally {
    reader.releaseLock();
  }
}

function mergeToolCall(
  calls: Map<number, NativeChatToolCall>,
  value: unknown,
): NativeChatToolCall | null {
  const record = asRecord(value);
  if (!record) {
    throw new NativeProviderError("Native upstream returned an invalid tool-call chunk", { kind: "malformed" });
  }
  if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) {
    throw new NativeProviderError("Native upstream returned a tool call without a valid index", { kind: "malformed" });
  }
  const index = record.index;
  const existing = calls.get(index);
  const functionRecord = asRecord(record.function);
  if (!existing) {
    if (record.type !== "function") {
      throw new NativeProviderError("Native upstream returned a tool call without a valid type", { kind: "malformed" });
    }
    if (typeof record.id !== "string" || !record.id.trim() || record.id !== record.id.trim()) {
      throw new NativeProviderError("Native upstream returned a tool call without a valid id", { kind: "malformed" });
    }
    if (!functionRecord || typeof functionRecord.name !== "string" || !functionRecord.name.trim() || functionRecord.name !== functionRecord.name.trim()) {
      throw new NativeProviderError("Native upstream returned a tool call without a valid function name", { kind: "malformed" });
    }
  }
  if (record.type !== undefined && record.type !== "function") {
    throw new NativeProviderError("Native upstream returned an unsupported tool-call type", { kind: "malformed" });
  }
  if (record.id !== undefined && (typeof record.id !== "string" || !record.id.trim() || record.id !== record.id.trim())) {
    throw new NativeProviderError("Native upstream returned an invalid tool-call id", { kind: "malformed" });
  }
  if (existing && typeof record.id === "string" && existing.id !== record.id) {
    throw new NativeProviderError("Native upstream returned conflicting tool-call ids", { kind: "malformed" });
  }
  if (record.function !== undefined && !asRecord(record.function)) {
    throw new NativeProviderError("Native upstream returned an invalid tool-call function", { kind: "malformed" });
  }
  const call = existing ?? {
    id: "",
    type: "function" as const,
    function: { name: "", arguments: "" },
  };
  if (!existing && typeof record.id === "string") call.id = record.id;
  if (functionRecord) {
    if (functionRecord.name !== undefined && (typeof functionRecord.name !== "string" || !functionRecord.name.trim() || functionRecord.name !== functionRecord.name.trim())) {
      throw new NativeProviderError("Native upstream returned an invalid tool-call function name", { kind: "malformed" });
    }
    if (functionRecord.arguments !== undefined && typeof functionRecord.arguments !== "string") {
      throw new NativeProviderError("Native upstream returned invalid tool-call arguments", { kind: "malformed" });
    }
    if (typeof functionRecord.name === "string") call.function.name += functionRecord.name;
    if (typeof functionRecord.arguments === "string") call.function.arguments += functionRecord.arguments;
  }
  calls.set(index, call);
  return call;
}

function parseNonStreamingResult(body: unknown): NativeCompletionResult {
  const root = asRecord(body);
  const choices = root && Array.isArray(root.choices) ? root.choices : [];
  if (choices.length === 0) {
    throw new NativeProviderError("Native upstream returned a non-streaming response without choices", { kind: "malformed" });
  }
  const choice = asRecord(choices[0]);
  if (!choice) {
    throw new NativeProviderError("Native upstream returned an invalid non-streaming choice", { kind: "malformed" });
  }
  const message = asRecord(choice?.message);
  if (!message) {
    throw new NativeProviderError("Native upstream returned a non-streaming response without a message", { kind: "malformed" });
  }
  const finishReason = readText(choice?.finish_reason);
  if (!finishReason) {
    throw new NativeProviderError("Native upstream returned a non-streaming response without finish_reason", {
      kind: "malformed",
    });
  }
  if (!SUPPORTED_FINISH_REASONS.has(finishReason)) {
    throw new NativeProviderError("Native upstream returned an unsupported finish_reason", {
      kind: "malformed",
    });
  }
  if (message?.content !== undefined && message?.content !== null && typeof message.content !== "string") {
    throw new NativeProviderError("Native upstream returned invalid non-streaming message content", {
      kind: "malformed",
    });
  }
  const text = readText(message?.content);
  if (message?.function_call !== undefined) {
    throw new NativeProviderError("Native upstream returned an unsupported legacy function_call", {
      kind: "malformed",
    });
  }
  if (message?.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw new NativeProviderError("Native upstream returned invalid non-streaming tool calls", {
      kind: "malformed",
    });
  }
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call) => {
        const record = asRecord(call);
        const fn = asRecord(record?.function);
        const id = readText(record?.id);
        const name = readText(fn?.name);
        if (record?.type !== "function" || !id.trim() || id !== id.trim() || !name.trim() || name !== name.trim()) {
          throw new NativeProviderError("Native upstream returned an invalid non-streaming tool call", { kind: "malformed" });
        }
        const args = readText(fn?.arguments);
        if (!args.trim()) {
          throw new NativeProviderError("Native upstream returned a tool call without arguments", { kind: "malformed" });
        }
        return {
          id,
          type: "function" as const,
          function: { name, arguments: args },
        };
      })
    : [];
  const toolCallIds = new Set<string>();
  for (const call of toolCalls) {
    if (toolCallIds.has(call.id)) {
      throw new NativeProviderError("Native upstream returned duplicate non-streaming tool-call ids", { kind: "malformed" });
    }
    toolCallIds.add(call.id);
  }
  if ((finishReason === "tool_calls") !== (toolCalls.length > 0)) {
    throw new NativeProviderError("Native upstream returned an incomplete non-streaming tool call response", {
      kind: "malformed",
    });
  }
  return {
    text,
    toolCalls,
    finishReason,
    usage: parseUsage(root?.usage),
  };
}

export async function completeNativeChat(request: NativeCompletionRequest): Promise<NativeCompletionResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(buildChatCompletionsEndpoint(request.baseUrl), {
      method: "POST",
      headers: {
        Accept: request.streaming === false ? "application/json" : "text/event-stream",
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildRequestBody(request)),
      signal: request.signal,
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.message === "Aborted")) throw error;
    throw new NativeProviderError(
      "Native upstream request failed",
      { kind: "transient", cause: error },
    );
  }

  if (!response.ok) {
    const retryable = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]).has(response.status);
    throw new NativeProviderError(
      `Native upstream returned HTTP ${response.status} [redacted]`,
      { kind: retryable ? "transient" : "permanent", status: response.status },
    );
  }

  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  const streaming = request.streaming !== false;
  if (!streaming) {
    if (contentType.includes("text/event-stream")) {
      throw new NativeProviderError("Native upstream returned a streaming response for a non-streaming request", {
        kind: "malformed",
      });
    }
    try {
      return parseNonStreamingResult(await response.json());
    } catch (error) {
      if (error instanceof NativeProviderError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || error.message === "Aborted")) throw error;
      throw new NativeProviderError("Native upstream returned malformed non-streaming JSON", {
        kind: "malformed",
      });
    }
  }
  if (!response.body || !contentType.includes("text/event-stream")) {
    throw new NativeProviderError("Native upstream returned a non-SSE response for a streaming request", {
      kind: "malformed",
    });
  }

  let text = "";
  let finishReason: string | undefined;
  let usage: NativeCompletionResult["usage"] = null;
  const toolCalls = new Map<number, NativeChatToolCall>();
  let sawChunk = false;
  let sawChoice = false;
  let sawDone = false;

  try {
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      sawChunk = true;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new NativeProviderError("Native upstream returned malformed SSE JSON", { kind: "malformed" });
      }
      const root = asRecord(payload);
      if (!root) {
        throw new NativeProviderError("Native upstream returned a malformed SSE payload", { kind: "malformed" });
      }
      usage = parseUsage(root.usage) ?? usage;
      if (root.choices !== undefined && !Array.isArray(root.choices)) {
        throw new NativeProviderError("Native upstream returned malformed SSE choices", { kind: "malformed" });
      }
      const choices = Array.isArray(root.choices) ? root.choices : [];
      const choice = asRecord(choices[0]);
      if (choices.length > 0 && !choice) {
        throw new NativeProviderError("Native upstream returned a malformed SSE choice", { kind: "malformed" });
      }
      if (choice) sawChoice = true;
      const hadFinishReason = Boolean(finishReason);
      const nextFinishReason = readText(choice?.finish_reason);
      if (nextFinishReason) {
        if (!SUPPORTED_FINISH_REASONS.has(nextFinishReason)) {
          throw new NativeProviderError("Native upstream returned an unsupported finish_reason", { kind: "malformed" });
        }
        if (finishReason && finishReason !== nextFinishReason) {
          throw new NativeProviderError("Native upstream returned conflicting finish reasons", { kind: "malformed" });
        }
        finishReason = nextFinishReason;
      }
      const delta = asRecord(choice?.delta);
      if (choice?.delta !== undefined && !delta) {
        throw new NativeProviderError("Native upstream returned a malformed SSE delta", { kind: "malformed" });
      }
      if (delta?.function_call !== undefined) {
        throw new NativeProviderError("Native upstream returned an unsupported legacy function_call", { kind: "malformed" });
      }
      if (delta?.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
        throw new NativeProviderError("Native upstream returned malformed SSE tool calls", { kind: "malformed" });
      }
      if (delta?.content !== undefined && delta.content !== null && typeof delta.content !== "string") {
        throw new NativeProviderError("Native upstream returned malformed SSE content", { kind: "malformed" });
      }
      const content = readText(delta?.content);
      const chunks = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
      if (hadFinishReason && (content || chunks.length > 0)) {
        throw new NativeProviderError("Native upstream returned data after finish_reason", { kind: "malformed" });
      }
      if (content) {
        text += content;
        request.onTextDelta?.(text);
      }
      for (const chunk of chunks) mergeToolCall(toolCalls, chunk);
    }
  } catch (error) {
    if (error instanceof NativeProviderError) throw error;
    if (error instanceof Error && (error.name === "AbortError" || error.message === "Aborted")) throw error;
    throw new NativeProviderError(
      "Native upstream stream disconnected",
      { kind: "transient", cause: error },
    );
  }

  if (!sawChunk || !sawChoice || !sawDone || !finishReason) {
    throw new NativeProviderError("Native upstream stream ended before a complete response", { kind: "malformed" });
  }
  const completedToolCallEntries = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right);
  if (completedToolCallEntries.some(([index], position) => index !== position)) {
    throw new NativeProviderError("Native upstream returned non-contiguous tool-call indexes", {
      kind: "malformed",
    });
  }
  const completedToolCalls = completedToolCallEntries.map(([, call]) => call);
  const toolCallIndexes = new Map<string, number>();
  for (const call of completedToolCalls) {
    if (!call.id || !call.function.name || !call.function.arguments.trim()) {
      throw new NativeProviderError(
        `Native upstream returned an incomplete tool call ${call.id || "<missing-id>"}`,
        { kind: "malformed" },
      );
    }
    const previousIndex = toolCallIndexes.get(call.id);
    if (previousIndex !== undefined) {
      throw new NativeProviderError("Native upstream returned duplicate tool-call ids", { kind: "malformed" });
    }
    toolCallIndexes.set(call.id, toolCalls.size);
  }
  if ((finishReason === "tool_calls") !== (completedToolCalls.length > 0)) {
    throw new NativeProviderError("Native upstream returned an incomplete tool call response", {
      kind: "malformed",
    });
  }

  return {
    text,
    toolCalls: completedToolCalls,
    finishReason,
    usage,
  };
}

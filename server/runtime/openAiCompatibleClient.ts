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
  options?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: string;
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

type JsonRecord = Record<string, unknown>;

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

function safeErrorText(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, "[redacted]").slice(0, 2_000);
}

function buildRequestBody(request: NativeCompletionRequest): JsonRecord {
  const body: JsonRecord = {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
  };
  const options = request.options;
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.topP !== undefined) body.top_p = options.topP;
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options?.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
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
  if (!record) return null;
  const index = Number(record.index);
  if (!Number.isInteger(index) || index < 0) return null;
  const existing = calls.get(index) ?? {
    id: "",
    type: "function" as const,
    function: { name: "", arguments: "" },
  };
  const functionRecord = asRecord(record.function);
  if (typeof record.id === "string" && record.id) existing.id = record.id;
  if (functionRecord) {
    if (typeof functionRecord.name === "string") existing.function.name += functionRecord.name;
    if (typeof functionRecord.arguments === "string") existing.function.arguments += functionRecord.arguments;
  }
  calls.set(index, existing);
  return existing;
}

function parseNonStreamingResult(body: unknown, request: NativeCompletionRequest): NativeCompletionResult {
  const root = asRecord(body);
  const choices = root && Array.isArray(root.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const text = readText(message?.content);
  if (text && request.onTextDelta) request.onTextDelta(text);
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call) => {
        const record = asRecord(call);
        const fn = asRecord(record?.function);
        return {
          id: readText(record?.id) || `native-tool-${Math.random().toString(36).slice(2)}`,
          type: "function" as const,
          function: { name: readText(fn?.name), arguments: readText(fn?.arguments) },
        };
      })
    : [];
  return {
    text,
    toolCalls,
    finishReason: readText(choice?.finish_reason) || undefined,
    usage: parseUsage(root?.usage),
  };
}

export async function completeNativeChat(request: NativeCompletionRequest): Promise<NativeCompletionResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(buildChatCompletionsEndpoint(request.baseUrl), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(request)),
    signal: request.signal,
    redirect: "error",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Native upstream returned HTTP ${response.status}: ${safeErrorText(text, request.apiKey)}`);
  }

  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.body || !contentType.includes("text/event-stream")) {
    return parseNonStreamingResult(await response.json(), request);
  }

  let text = "";
  let finishReason: string | undefined;
  let usage: NativeCompletionResult["usage"] = null;
  const toolCalls = new Map<number, NativeChatToolCall>();

  for await (const data of readSseData(response.body)) {
    if (data === "[DONE]") break;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const root = asRecord(payload);
    usage = parseUsage(root?.usage) ?? usage;
    const choices = root && Array.isArray(root.choices) ? root.choices : [];
    const choice = asRecord(choices[0]);
    finishReason = readText(choice?.finish_reason) || finishReason;
    const delta = asRecord(choice?.delta);
    const content = readText(delta?.content);
    if (content) {
      text += content;
      request.onTextDelta?.(text);
    }
    const chunks = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const chunk of chunks) mergeToolCall(toolCalls, chunk);
  }

  return {
    text,
    toolCalls: [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call),
    finishReason,
    usage,
  };
}

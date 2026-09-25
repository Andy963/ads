import type {
  NativeChatMessage,
  NativeChatToolCall,
  NativeToolDefinition,
} from "./openAiCompatibleClient.js";

export const DEFAULT_NATIVE_CONTEXT_WINDOW = 32_768;
export const DEFAULT_NATIVE_CONTEXT_RESERVED_TOKENS = 4_096;

const MIN_CONTEXT_WINDOW = 256;
const MESSAGE_OVERHEAD_TOKENS = 8;
const TOOL_OUTPUT_TRUNCATION_MARKER = "[Native context truncated: tool output omitted]";

export interface NativeContextProjectionOptions {
  contextWindow?: number;
  reservedTokens?: number;
  maxOutputTokens?: number;
  tools?: NativeToolDefinition[];
}

export interface NativeContextProjectionDiagnostic {
  compacted: boolean;
  contextWindow: number;
  reservedTokens: number;
  estimatedTokens: number;
  droppedMessages: number;
  truncatedToolOutputs: number;
}

export interface NativeContextProjection {
  messages: NativeChatMessage[];
  diagnostic: NativeContextProjectionDiagnostic;
}

export class NativeContextLimitError extends Error {
  readonly code = "NATIVE_CONTEXT_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "NativeContextLimitError";
  }
}

interface ContextTurn {
  messages: NativeChatMessage[];
}

function cloneMessage(message: NativeChatMessage): NativeChatMessage {
  return {
    ...message,
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            function: { ...call.function },
          })),
        }
      : {}),
  };
}

function textTokens(value: string | null | undefined): number {
  return Math.ceil(String(value ?? "").length / 4);
}

export function estimateNativeMessageTokens(message: NativeChatMessage): number {
  const toolCallTokens = message.tool_calls?.reduce(
    (total, call) => total + estimateNativeToolCallTokens(call),
    0,
  ) ?? 0;
  return MESSAGE_OVERHEAD_TOKENS + textTokens(message.content) + textTokens(message.name) + toolCallTokens;
}

function estimateNativeToolCallTokens(call: NativeChatToolCall): number {
  return MESSAGE_OVERHEAD_TOKENS
    + textTokens(call.id)
    + textTokens(call.function.name)
    + textTokens(call.function.arguments);
}

function estimateMessagesTokens(messages: NativeChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateNativeMessageTokens(message), 0);
}

function estimateToolDefinitionTokens(tools: NativeToolDefinition[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return tools.reduce(
    (total, tool) => total + MESSAGE_OVERHEAD_TOKENS + textTokens(JSON.stringify(tool)),
    0,
  );
}

function normalizeContextWindow(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_NATIVE_CONTEXT_WINDOW;
  return Math.max(MIN_CONTEXT_WINDOW, Math.floor(value));
}

function normalizeReservedTokens(value: number | undefined, contextWindow: number): number {
  const requested = value === undefined || !Number.isFinite(value)
    ? DEFAULT_NATIVE_CONTEXT_RESERVED_TOKENS
    : Math.floor(value);
  const conservativeCap = Math.max(64, Math.floor(contextWindow * 0.25));
  return Math.max(64, Math.min(requested, conservativeCap, contextWindow - 64));
}

function assertToolCall(call: NativeChatToolCall, index: number): void {
  if (!call || typeof call.id !== "string" || !call.id.trim()) {
    throw new NativeContextLimitError(`Invalid Native tool call at index ${index}: missing tool call id.`);
  }
  if (!call.function || typeof call.function.name !== "string" || !call.function.name.trim()) {
    throw new NativeContextLimitError(`Invalid Native tool call ${call.id}: missing function name.`);
  }
  if (typeof call.function.arguments !== "string") {
    throw new NativeContextLimitError(`Invalid Native tool call ${call.id}: arguments must be a string.`);
  }
}

function groupMessages(messages: NativeChatMessage[]): {
  system: NativeChatMessage[];
  turns: ContextTurn[];
} {
  const system: NativeChatMessage[] = [];
  const turns: ContextTurn[] = [];
  let current: NativeChatMessage[] | null = null;
  let pendingToolCalls = new Set<string>();

  const finishTurn = (): void => {
    if (current === null) return;
    if (pendingToolCalls.size > 0) {
      throw new NativeContextLimitError(
        `Invalid Native message sequence: tool results are missing for ${[...pendingToolCalls].join(", ")}.`,
      );
    }
    turns.push({ messages: current });
    current = null;
    pendingToolCalls = new Set<string>();
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      throw new NativeContextLimitError("Invalid Native message sequence: message is not an object.");
    }
    if (message.role === "system") {
      if (current !== null) {
        throw new NativeContextLimitError("Invalid Native message sequence: system message appears after a turn.");
      }
      system.push(cloneMessage(message));
      continue;
    }
    if (message.role === "user") {
      finishTurn();
      current = [cloneMessage(message)];
      continue;
    }
    if (current === null) {
      throw new NativeContextLimitError(
        `Invalid Native message sequence: ${message.role} message appears before a user message.`,
      );
    }
    if (message.role === "assistant") {
      if (pendingToolCalls.size > 0) {
        throw new NativeContextLimitError(
          `Invalid Native message sequence: assistant message interrupted pending tool results for ${[...pendingToolCalls].join(", ")}.`,
        );
      }
      const calls = message.tool_calls ?? [];
      calls.forEach((call, index) => assertToolCall(call, index));
      const ids = new Set<string>();
      for (const call of calls) {
        if (ids.has(call.id)) {
          throw new NativeContextLimitError(`Invalid Native message sequence: duplicate tool call id ${call.id}.`);
        }
        ids.add(call.id);
      }
      current.push(cloneMessage(message));
      for (const call of calls) pendingToolCalls.add(call.id);
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      if (!pendingToolCalls.has(toolCallId)) {
        throw new NativeContextLimitError(
          `Invalid Native message sequence: tool result ${toolCallId || "<missing>"} has no matching tool call.`,
        );
      }
      current.push(cloneMessage(message));
      pendingToolCalls.delete(toolCallId);
      continue;
    }
    throw new NativeContextLimitError("Invalid Native message sequence: unsupported message role.");
  }
  finishTurn();
  return { system, turns };
}

function truncateToolContent(content: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return TOOL_OUTPUT_TRUNCATION_MARKER;
  const markerTokens = textTokens(TOOL_OUTPUT_TRUNCATION_MARKER);
  if (tokenBudget <= markerTokens) {
    return TOOL_OUTPUT_TRUNCATION_MARKER.slice(0, Math.max(0, tokenBudget * 4));
  }
  const contentBudget = tokenBudget - markerTokens;
  return `${content.slice(0, contentBudget * 4)}${TOOL_OUTPUT_TRUNCATION_MARKER}`;
}

function fitToolTurn(turn: ContextTurn, tokenBudget: number): { turn: ContextTurn; truncated: number } {
  const toolIndexes = turn.messages
    .map((message, index) => message.role === "tool" ? index : -1)
    .filter((index) => index >= 0);
  if (toolIndexes.length === 0) {
    throw new NativeContextLimitError(
      `Native context limit exceeded: the latest indivisible turn requires ${estimateMessagesTokens(turn.messages)} tokens, but only ${tokenBudget} input tokens are available.`,
    );
  }

  const fixedMessages = turn.messages.map((message) => message.role === "tool"
    ? { ...cloneMessage(message), content: "" }
    : cloneMessage(message));
  let remaining = tokenBudget - estimateMessagesTokens(fixedMessages);
  if (remaining < 0) {
    throw new NativeContextLimitError(
      "Native context limit exceeded: the latest tool turn contains fixed message overhead larger than the context budget.",
    );
  }

  const fitted = fixedMessages;
  let truncated = 0;
  for (let position = 0; position < toolIndexes.length; position += 1) {
    const index = toolIndexes[position];
    const original = turn.messages[index];
    if (!original) continue;
    const originalContent = typeof original.content === "string" ? original.content : String(original.content ?? "");
    const originalTokens = textTokens(originalContent);
    const slots = toolIndexes.length - position;
    const perToolBudget = Math.floor(remaining / slots);
    if (originalTokens <= perToolBudget) {
      fitted[index] = { ...cloneMessage(original), content: originalContent };
      remaining -= originalTokens;
      continue;
    }
    if (perToolBudget <= 0) {
      throw new NativeContextLimitError(
        "Native context limit exceeded: the latest tool turn cannot retain truncation markers within the context budget.",
      );
    }
    fitted[index] = { ...cloneMessage(original), content: truncateToolContent(originalContent, perToolBudget) };
    remaining -= perToolBudget;
    truncated += 1;
  }

  const fittedTokens = estimateMessagesTokens(fitted);
  if (fittedTokens > tokenBudget) {
    throw new NativeContextLimitError(
      `Native context limit exceeded: truncated tool turn still requires ${fittedTokens} tokens, but only ${tokenBudget} input tokens are available.`,
    );
  }
  return { turn: { messages: fitted }, truncated };
}

export function projectNativeContext(
  messages: NativeChatMessage[],
  options: NativeContextProjectionOptions = {},
): NativeContextProjection {
  const contextWindow = normalizeContextWindow(options.contextWindow);
  const reservedTokens = normalizeReservedTokens(
    options.reservedTokens ?? options.maxOutputTokens,
    contextWindow,
  );
  const inputBudget = contextWindow - reservedTokens;
  if (inputBudget <= 0) {
    throw new NativeContextLimitError(
      `Native context limit exceeded: context window ${contextWindow} leaves no input budget after reserving ${reservedTokens} tokens.`,
    );
  }

  const grouped = groupMessages(messages);
  const toolDefinitionTokens = estimateToolDefinitionTokens(options.tools);
  const systemTokens = estimateMessagesTokens(grouped.system);
  if (systemTokens + toolDefinitionTokens > inputBudget) {
    throw new NativeContextLimitError(
      `Native context limit exceeded: system messages and tool definitions require ${systemTokens + toolDefinitionTokens} tokens, but only ${inputBudget} input tokens are available.`,
    );
  }

  const selected: ContextTurn[] = [];
  let usedTokens = systemTokens + toolDefinitionTokens;
  let droppedMessages = 0;
  let truncatedToolOutputs = 0;
  for (let index = grouped.turns.length - 1; index >= 0; index -= 1) {
    const turn = grouped.turns[index];
    if (!turn) continue;
    const turnTokens = estimateMessagesTokens(turn.messages);
    if (usedTokens + turnTokens <= inputBudget) {
      selected.push(turn);
      usedTokens += turnTokens;
      continue;
    }

    if (index < grouped.turns.length - 1) {
      droppedMessages += turn.messages.length;
      continue;
    }

    const remainingBudget = inputBudget - usedTokens;
    const fitted = fitToolTurn(turn, remainingBudget);
    selected.push(fitted.turn);
    usedTokens += estimateMessagesTokens(fitted.turn.messages);
    truncatedToolOutputs += fitted.truncated;
    droppedMessages += grouped.turns.length - index - 1;
    break;
  }
  selected.reverse();

  const compacted = selected.length < grouped.turns.length || truncatedToolOutputs > 0;
  if (droppedMessages === 0 && selected.length < grouped.turns.length) {
    droppedMessages = messages.length - grouped.system.length - selected.flatMap((turn) => turn.messages).length;
  }
  const projectedMessages = [
    ...grouped.system,
    ...selected.flatMap((turn) => turn.messages),
  ];
  return {
    messages: projectedMessages,
    diagnostic: {
      compacted,
      contextWindow,
      reservedTokens,
      estimatedTokens: estimateMessagesTokens(projectedMessages) + toolDefinitionTokens,
      droppedMessages,
      truncatedToolOutputs,
    },
  };
}

export function formatNativeContextDiagnostic(diagnostic: NativeContextProjectionDiagnostic): string {
  if (!diagnostic.compacted) return "Native context projection completed without compaction.";
  return [
    "Native context projection compacted older turns.",
    `Estimated ${diagnostic.estimatedTokens}/${diagnostic.contextWindow} tokens.`,
    `Dropped ${diagnostic.droppedMessages} message(s).`,
    `Truncated ${diagnostic.truncatedToolOutputs} tool output(s).`,
  ].join(" ");
}

import type { NativeChatMessage } from "./openAiCompatibleClient.js";
import type { NativeTranscriptTurnStatus } from "../state/nativeTranscriptStore.js";

export interface NativeContinuationTurn {
  status: NativeTranscriptTurnStatus;
  messages: NativeChatMessage[];
}

export interface NativeContinuationContext {
  messages: NativeChatMessage[];
  pendingTurns: number;
}

/** Project terminal evidence for a new request without rewriting the transcript. */
export function projectNativeContinuationTurn(turn: NativeContinuationTurn): NativeChatMessage[] {
  if (turn.status === "running" || turn.messages.length === 0) return [];
  const messages = structuredClone(turn.messages);
  if (turn.status === "completed") return messages;

  const pending = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === "tool" && message.tool_call_id) pending.delete(message.tool_call_id);
  }
  // A stopped process may have changed external state without recording a result.
  // Close the protocol pair, but never fabricate success or replay the operation.
  for (const id of pending) {
    messages.push({
      role: "tool",
      tool_call_id: id,
      nativeToolOutcome: "unknown",
      content: JSON.stringify({
        status: "unknown",
        turn_status: turn.status,
        message: "No completion result was recorded. The tool may not have run or may have produced side effects. Inspect current state before retrying; do not assume success.",
      }),
    });
  }
  messages.push({
    role: "assistant",
    content: `[Native runtime: this turn was ${turn.status}, not completed. The original user request and recorded tool results above remain context. No tools have been replayed. Follow the next user instruction and verify any unknown tool outcome before repeating an operation.]`,
  });
  return messages;
}

export function projectNativeContinuation(turns: NativeContinuationTurn[]): NativeContinuationContext {
  const context: NativeContinuationContext = { messages: [], pendingTurns: 0 };
  for (const turn of turns) {
    const messages = projectNativeContinuationTurn(turn);
    if (!messages.length) continue;
    context.messages.push(...messages);
    context.pendingTurns = turn.status === "completed" ? 0 : context.pendingTurns + 1;
  }
  return context;
}

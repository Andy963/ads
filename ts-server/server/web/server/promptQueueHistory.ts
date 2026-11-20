import { getHistoryClientMessageId } from "../../utils/historyKind.js";
import type { HistoryEntry } from "../../utils/historyStore.js";

export type PromptQueueHistoryOutcome = "missing" | "pending" | "completed" | "failed";

export function getPromptQueueHistoryOutcome(
  entries: HistoryEntry[],
  clientMessageId: string,
  allowErrorReplay = false,
): PromptQueueHistoryOutcome {
  const persisted = entries.some(
    (entry) => entry.role === "user" && getHistoryClientMessageId(entry.kind) === clientMessageId,
  );
  if (!persisted) return "missing";
  // The last terminal entry of the turn decides its outcome: partial assistant
  // output followed by an error means the turn failed, so an authorized replay
  // must run again instead of being reconciled as completed.
  let inTurn = false;
  let lastTerminal: "completed" | "failed" | null = null;
  for (const entry of entries) {
    if (entry.role === "user") {
      inTurn = getHistoryClientMessageId(entry.kind) === clientMessageId;
      if (inTurn) lastTerminal = null;
      continue;
    }
    if (!inTurn) continue;
    if (entry.role === "ai") lastTerminal = "completed";
    else if (entry.role === "status" && entry.kind === "error") lastTerminal = "failed";
  }
  if (lastTerminal === "completed") return "completed";
  if (lastTerminal === "failed") return allowErrorReplay ? "pending" : "failed";
  return "pending";
}

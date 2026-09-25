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
  let awaitingTerminal = false;
  let failed = false;
  for (const entry of entries) {
    if (entry.role === "user") {
      awaitingTerminal = getHistoryClientMessageId(entry.kind) === clientMessageId;
      failed = false;
      continue;
    }
    if (!awaitingTerminal) continue;
    if (entry.role === "ai") {
      return "completed";
    }
    if (!allowErrorReplay && entry.role === "status" && entry.kind === "error") {
      failed = true;
    }
  }
  return failed ? "failed" : "pending";
}

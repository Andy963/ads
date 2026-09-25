import { getHistoryClientMessageId } from "../../utils/historyKind.js";
import { isClientMessageCompleted } from "./ws/preflight.js";
import type { HistoryEntry } from "../../utils/historyStore.js";

export type PromptQueueHistoryOutcome = "missing" | "pending" | "completed";

export function getPromptQueueHistoryOutcome(
  entries: HistoryEntry[],
  clientMessageId: string,
  allowErrorReplay = false,
): PromptQueueHistoryOutcome {
  const persisted = entries.some(
    (entry) => entry.role === "user" && getHistoryClientMessageId(entry.kind) === clientMessageId,
  );
  if (!persisted) return "missing";
  return isClientMessageCompleted(entries, clientMessageId, { allowErrorReplay }) ? "completed" : "pending";
}

import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import type { HistoryEntry, HistoryStore } from "../../../utils/historyStore.js";

function isCdCommand(entry: HistoryEntry): boolean {
  return entry.role === "user" && /^\/cd\b/i.test(String(entry.text ?? "").trim());
}

export function buildTaskResumeHistorySnapshot(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const sanitizedHistory = entries.map((entry) => {
    if (entry.role !== "ai") {
      return entry;
    }
    const cleanedText = stripLeadingTranslation(entry.text);
    if (cleanedText === entry.text) {
      return entry;
    }
    return { ...entry, text: cleanedText };
  });

  let lastCdIndex = -1;
  for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
    if (isCdCommand(sanitizedHistory[i])) {
      lastCdIndex = i;
      break;
    }
  }

  return lastCdIndex >= 0
    ? sanitizedHistory.filter((entry, idx) => !isCdCommand(entry) || idx === lastCdIndex)
    : sanitizedHistory;
}

export function sendTaskResumeHistorySnapshot(args: {
  historyStore: Pick<HistoryStore, "get">;
  historyKey: string;
  send: (payload: unknown) => void;
}): void {
  args.send({
    type: "history",
    items: buildTaskResumeHistorySnapshot(args.historyStore.get(args.historyKey)),
  });
}

import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";

export function buildHistoryBootstrapPayload(entries: HistoryEntry[]): { type: "history"; items: HistoryEntry[] } | null {
  if (!entries.length) {
    return null;
  }
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
  const cdPattern = /^\/cd\b/i;
  const isCdCommand = (entry: { role: string; text: string }) =>
    entry.role === "user" && cdPattern.test(String(entry.text ?? "").trim());
  let lastCdIndex = -1;
  for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
    if (isCdCommand(sanitizedHistory[i])) {
      lastCdIndex = i;
      break;
    }
  }
  const items =
    lastCdIndex >= 0
      ? sanitizedHistory.filter((entry, idx) => !isCdCommand(entry) || idx === lastCdIndex)
      : sanitizedHistory;
  return { type: "history", items };
}

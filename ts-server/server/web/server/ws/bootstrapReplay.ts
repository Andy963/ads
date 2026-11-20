import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";
import { stripCommandHistoryOutput } from "../commandPresentation.js";

export function buildHistoryBootstrapPayload(entries: HistoryEntry[]): { type: "history"; items: HistoryEntry[] } | null {
  if (!entries.length) {
    return null;
  }
  const visibleEntries = entries.filter((entry) => {
    const kind = String(entry.kind ?? "").trim().toLowerCase();
    return kind !== "thought" && kind !== "plan" && !kind.startsWith("plan:") && entry.role !== "thought";
  });
  if (visibleEntries.length === 0) {
    return null;
  }
  const sanitizedHistory = visibleEntries.map((entry) => {
    const commandText = stripCommandHistoryOutput(entry.text, entry.kind);
    const cleanedText = entry.role === "ai" ? stripLeadingTranslation(commandText) : commandText;
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

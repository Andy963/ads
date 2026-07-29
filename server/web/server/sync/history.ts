import type { HistoryEntry } from "../../../utils/historyStore.js";

export function mergeSyncHistory(groups: HistoryEntry[][], limit = 200): HistoryEntry[] {
  const deduped = new Map<string, HistoryEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const normalized: HistoryEntry = {
        role: String(entry.role ?? ""),
        text: String(entry.text ?? ""),
        ts: Number(entry.ts) || 0,
        kind: String(entry.kind ?? "").trim() || undefined,
      };
      if (!normalized.role || !normalized.text.trim()) continue;
      const key = [normalized.role, normalized.text, normalized.kind ?? "", normalized.ts].join("\u0000");
      if (!deduped.has(key)) deduped.set(key, normalized);
    }
  }
  return [...deduped.values()]
    .sort((left, right) => left.ts - right.ts)
    .slice(-Math.max(1, limit));
}

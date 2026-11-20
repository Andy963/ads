import type { HistoryEntry } from "../../../utils/historyStore.js";

const RESUME_TRANSCRIPT_MAX_CHARS = 10_000;

type ResumeTranscriptLine = {
  speaker: "User" | "Assistant";
  text: string;
};

/** Build a bounded transcript from the active lane history only. */
export function buildHistoryStoreResumeTranscript(
  entries: readonly HistoryEntry[],
  maxChars = RESUME_TRANSCRIPT_MAX_CHARS,
): string {
  const lastDividerIndex = entries.map((entry) => entry.kind).lastIndexOf("session_divider");
  const effectiveEntries = lastDividerIndex >= 0 ? entries.slice(lastDividerIndex + 1) : entries;
  const rawTranscript = effectiveEntries
    .filter((entry) => entry.role === "user" || entry.role === "ai")
    .map((entry): ResumeTranscriptLine => ({
      speaker: entry.role === "user" ? "User" : "Assistant",
      text: String(entry.text ?? "").trim(),
    }))
    .filter((line) => Boolean(line.text))
    .map((line) => `${line.speaker}: ${line.text}`)
    .join("\n");

  return rawTranscript.length <= maxChars
    ? rawTranscript
    : rawTranscript.slice(rawTranscript.length - maxChars);
}

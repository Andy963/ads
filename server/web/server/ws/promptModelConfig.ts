import type { Input, InputTextPart } from "../../../agents/protocol/types.js";

const HISTORY_INJECTION_MAX_ENTRIES = 20;
const HISTORY_INJECTION_MAX_CHARS = 8_000;
const HISTORY_INJECTION_MAX_CHARS_PER_ENTRY = 800;

type HistoryInjectionEntry = { role: string; text: string; kind?: string; ts?: number };

export type HistoryInjectionDetails = {
  text: string;
  entryCount: number;
  earliestTs?: number;
  latestTs?: number;
};

export function parseModelReasoningEffortFromPayload(payload: unknown): { present: boolean; effort?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { present: false };
  }
  const rec = payload as Record<string, unknown>;
  const raw = rec["model_reasoning_effort"] ?? rec["modelReasoningEffort"];
  if (raw === undefined) {
    return { present: false };
  }
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!normalized || normalized === "default") {
    return { present: true, effort: undefined };
  }
  const allow = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
  if (!allow.has(normalized)) {
    return { present: true, effort: undefined };
  }
  return { present: true, effort: normalized };
}

export function parseModelFromPayload(payload: unknown): { present: boolean; model?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { present: false };
  }
  const rec = payload as Record<string, unknown>;
  const raw = rec["model"] ?? rec["model_id"] ?? rec["modelId"];
  if (raw === undefined) {
    return { present: false };
  }
  const normalized = typeof raw === "string" ? raw.trim() : "";
  const lowered = normalized.toLowerCase();
  if (!normalized || lowered === "auto" || lowered === "default") {
    return { present: true, model: undefined };
  }
  return { present: true, model: normalized };
}

export function parseAgentIdFromPayload(payload: unknown): { present: boolean; agentId?: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { present: false };
  }
  const rec = payload as Record<string, unknown>;
  const raw = rec["agentId"] ?? rec["agent_id"] ?? rec["agent"];
  if (raw === undefined) {
    return { present: false };
  }
  const normalized = typeof raw === "string" ? raw.trim() : "";
  return normalized ? { present: true, agentId: normalized } : { present: true };
}

function labelForHistoryInjectionEntry(entry: HistoryInjectionEntry): string | null {
  if (entry.role === "user") return "User";
  if (entry.role === "ai") return "Assistant";
  if (entry.role === "status" && entry.kind === "execute") return "Command output";
  if (entry.role === "status" && entry.kind === "error") return "System error";
  return null;
}

function truncateHistoryInjectionText(entry: HistoryInjectionEntry, text: string): string {
  if (text.length <= HISTORY_INJECTION_MAX_CHARS_PER_ENTRY) {
    return text;
  }
  if (entry.role === "status" && entry.kind === "execute") {
    const normalized = text.replace(/\r\n/g, "\n");
    const firstNewlineIndex = normalized.indexOf("\n");
    if (firstNewlineIndex > 0) {
      const commandHeader = normalized.slice(0, firstNewlineIndex).trimEnd();
      const output = normalized.slice(firstNewlineIndex + 1);
      const tailBudget = HISTORY_INJECTION_MAX_CHARS_PER_ENTRY - commandHeader.length - 2;
      if (commandHeader.startsWith("$ ") && output && tailBudget > 0) {
        return `${commandHeader}\n…${output.slice(Math.max(0, output.length - tailBudget))}`;
      }
    }
    return `…${normalized.slice(Math.max(0, normalized.length - HISTORY_INJECTION_MAX_CHARS_PER_ENTRY))}`;
  }
  if (entry.role === "status" && entry.kind === "error") {
    return `…${text.slice(text.length - HISTORY_INJECTION_MAX_CHARS_PER_ENTRY)}`;
  }
  return `${text.slice(0, HISTORY_INJECTION_MAX_CHARS_PER_ENTRY)}…`;
}

function trimHistoryInjectionLines(lines: string[], maxChars: number): {
  text: string;
  keptIndices: number[];
} {
  const kept: string[] = [];
  const keptIndices: number[] = [];
  let totalChars = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const separatorChars = kept.length > 0 ? 1 : 0;
    const nextTotal = totalChars + separatorChars + line.length;

    if (kept.length > 0 && nextTotal > maxChars) {
      break;
    }
    if (kept.length === 0 && line.length > maxChars) {
      return { text: line.slice(line.length - maxChars), keptIndices: [i] };
    }

    kept.unshift(line);
    keptIndices.unshift(i);
    totalChars = nextTotal;
  }

  return { text: kept.join("\n"), keptIndices };
}

export function buildHistoryInjectionDetails(entries: HistoryInjectionEntry[]): HistoryInjectionDetails | null {
  const relevant = entries
    .map((entry) => ({ entry, label: labelForHistoryInjectionEntry(entry) }))
    .filter((item): item is { entry: HistoryInjectionEntry; label: string } => Boolean(item.label));
  if (relevant.length === 0) {
    return null;
  }
  const recent = relevant.slice(-HISTORY_INJECTION_MAX_ENTRIES);
  const lines: string[] = [];
  const lineEntries: HistoryInjectionEntry[] = [];
  for (const { entry, label } of recent) {
    const text = String(entry.text ?? "").trim();
    if (!text) continue;
    const truncated = truncateHistoryInjectionText(entry, text);
    lines.push(`${label}: ${truncated}`);
    lineEntries.push(entry);
  }
  if (lines.length === 0) {
    return null;
  }
  const { text: transcript, keptIndices } = trimHistoryInjectionLines(lines, HISTORY_INJECTION_MAX_CHARS);
  if (!transcript) {
    return null;
  }
  const includedEntries = keptIndices
    .map((idx) => lineEntries[idx])
    .filter((entry): entry is HistoryInjectionEntry => Boolean(entry));
  let earliestTs: number | undefined;
  let latestTs: number | undefined;
  for (const entry of includedEntries) {
    const ts = typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : undefined;
    if (typeof ts !== "number") continue;
    if (earliestTs === undefined || ts < earliestTs) earliestTs = ts;
    if (latestTs === undefined || ts > latestTs) latestTs = ts;
  }
  const text = [
    "[Context restore] Recent chat history (for reference only). Do not repeat it; answer the user's next request directly:",
    "",
    transcript,
    "",
    "---",
    "",
  ].join("\n");
  return {
    text,
    entryCount: includedEntries.length,
    earliestTs,
    latestTs,
  };
}

export function buildHistoryInjectionContext(entries: HistoryInjectionEntry[]): string | null {
  const details = buildHistoryInjectionDetails(entries);
  return details ? details.text : null;
}

export function prependContextToInput(context: string, input: Input): Input {
  if (typeof input === "string") {
    return `${context}${input}`;
  }
  if (Array.isArray(input)) {
    const prefix: InputTextPart = { type: "text", text: context };
    return [prefix, ...input];
  }
  return `${context}${String(input ?? "")}`;
}

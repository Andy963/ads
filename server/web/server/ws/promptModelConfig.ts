import type { Input, InputTextPart } from "../../../agents/protocol/types.js";

const HISTORY_INJECTION_MAX_ENTRIES = 20;
const HISTORY_INJECTION_MAX_CHARS = 8_000;

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
  const allow = new Set(["low", "medium", "high", "xhigh"]);
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

export function buildHistoryInjectionContext(entries: Array<{ role: string; text: string }>): string | null {
  const relevant = entries.filter((e) => e.role === "user" || e.role === "ai");
  if (relevant.length === 0) {
    return null;
  }
  const recent = relevant.slice(-HISTORY_INJECTION_MAX_ENTRIES);
  const lines: string[] = [];
  for (const entry of recent) {
    const role = entry.role === "user" ? "User" : "Assistant";
    const text = String(entry.text ?? "").trim();
    if (!text) continue;
    const maxPerEntry = 800;
    const truncated = text.length <= maxPerEntry ? text : `${text.slice(0, maxPerEntry)}…`;
    lines.push(`${role}: ${truncated}`);
  }
  if (lines.length === 0) {
    return null;
  }
  let transcript = lines.join("\n");
  if (transcript.length > HISTORY_INJECTION_MAX_CHARS) {
    transcript = transcript.slice(transcript.length - HISTORY_INJECTION_MAX_CHARS);
  }
  return [
    "[Context restore] Recent chat history (for reference only). Do not repeat it; answer the user's next request directly:",
    "",
    transcript,
    "",
    "---",
    "",
  ].join("\n");
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

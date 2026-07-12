function normalizeStorageKeySegment(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || fallback;
}

export function normalizeReasoningEffort(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max" ||
    normalized === "ultra"
  ) {
    return normalized;
  }
  return "high";
}

export function normalizeModelId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || "auto";
}

export function buildReasoningEffortStorageKey(sessionId: string, chatSessionId: string, agentId?: string): string {
  const base = `ads.reasoningEffort.${normalizeStorageKeySegment(sessionId, "unknown")}.${normalizeStorageKeySegment(chatSessionId, "main")}`;
  return agentId ? `${base}.${normalizeStorageKeySegment(agentId, "unknown")}` : base;
}

export function buildModelIdStorageKey(sessionId: string, chatSessionId: string, agentId?: string): string {
  const base = `ads.modelId.${normalizeStorageKeySegment(sessionId, "unknown")}.${normalizeStorageKeySegment(chatSessionId, "main")}`;
  return agentId ? `${base}.${normalizeStorageKeySegment(agentId, "unknown")}` : base;
}

function normalizeStorageKeySegment(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || fallback;
}

export function normalizeReasoningEffort(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized;
  }
  if (normalized === "low") {
    return "medium";
  }
  return "high";
}

export function normalizeModelId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || "auto";
}

export function buildReasoningEffortStorageKey(sessionId: string, chatSessionId: string): string {
  return `ads.reasoningEffort.${normalizeStorageKeySegment(sessionId, "unknown")}.${normalizeStorageKeySegment(chatSessionId, "main")}`;
}

export function buildModelIdStorageKey(sessionId: string, chatSessionId: string): string {
  return `ads.modelId.${normalizeStorageKeySegment(sessionId, "unknown")}.${normalizeStorageKeySegment(chatSessionId, "main")}`;
}

export function normalizeReasoningEffort(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "off" ||
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  return "high";
}

export function normalizeModelId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || "auto";
}

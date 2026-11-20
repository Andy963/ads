export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 80;

export function readAutoCompactConfig(
  config?: Record<string, unknown> | null,
): Record<string, unknown> {
  const raw = config?.autoCompact;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function resolveAutoCompactThresholdPercent(
  value: unknown,
  fallback = DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 100 ? parsed : fallback;
}

function normalizeStorageKeySegment(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return normalized || fallback;
}

import { laneIdVariants } from "./laneIds.js";

export { laneIdVariants };

export function normalizeReasoningEffort(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "off" ||
    normalized === "none" ||
    normalized === "minimal" ||
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

/**
 * Read a per-lane localStorage preference, falling back to the legacy planner
 * lane key when the advisor key has no value. New writes always go to the
 * primary (advisor) key.
 */
export function readLanePreferenceWithLegacyFallback(
  buildKey: (sessionId: string, chatSessionId: string, agentId?: string) => string,
  sessionId: string,
  chatSessionId: string,
  agentId?: string,
): string | null {
  for (const chat of laneIdVariants(chatSessionId)) {
    try {
      const value = localStorage.getItem(buildKey(sessionId, chat, agentId));
      if (value !== null && value !== undefined) return value;
    } catch {
      // ignore storage errors; try the next variant
    }
  }
  return null;
}

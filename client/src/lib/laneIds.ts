// Canonical lane identifiers. The Advisor lane was formerly named "planner";
// the legacy id is still accepted from old persisted state (localStorage,
// outbox entries) and mapped forward. New writes always use "advisor".
export const ADVISOR_LANE_ID = "advisor";
export const WORKER_LANE_ID = "worker";
export const LEGACY_ADVISOR_LANE_ID = "planner";

export function normalizeLaneId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized === LEGACY_ADVISOR_LANE_ID ? ADVISOR_LANE_ID : normalized;
}

/** Primary id first, then the legacy planner variant when the lane is the advisor lane. */
export function laneIdVariants(value: unknown): string[] {
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];
  return normalized === ADVISOR_LANE_ID ? [ADVISOR_LANE_ID, LEGACY_ADVISOR_LANE_ID] : [normalized];
}

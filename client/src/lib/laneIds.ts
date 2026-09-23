// Canonical lane identifiers. Evolved to Acopilot and Actions.
export const ACOPILOT_LANE_ID = "acopilot";
export const ACTIONS_LANE_ID = "actions";
export const ADVISOR_LANE_ID = "advisor";
export const WORKER_LANE_ID = "worker";
export const LEGACY_ADVISOR_LANE_ID = "planner";

export function normalizeLaneId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (normalized === LEGACY_ADVISOR_LANE_ID || normalized === ADVISOR_LANE_ID) {
    return ACOPILOT_LANE_ID;
  }
  if (normalized === WORKER_LANE_ID) {
    return ACTIONS_LANE_ID;
  }
  return normalized;
}

/** Primary id first, then the legacy variants when applicable. */
export function laneIdVariants(value: unknown): string[] {
  const normalized = normalizeLaneId(value);
  if (!normalized) return [];
  if (normalized === ACOPILOT_LANE_ID) {
    return [ACOPILOT_LANE_ID, ADVISOR_LANE_ID, LEGACY_ADVISOR_LANE_ID];
  }
  if (normalized === ACTIONS_LANE_ID) {
    return [ACTIONS_LANE_ID, WORKER_LANE_ID];
  }
  return [normalized];
}

// Canonical lane identifiers. Evolved to Acopilot and Actions.
//
// The vocabulary itself is owned by the shared terminology contract so the
// server and the client cannot drift apart. This module keeps the client's
// existing API surface and its permissive pass-through behaviour; moving
// consumers onto the strict contract is a separate slice.
import {
  ACTIONS_LANE_ID,
  ACOPILOT_LANE_ID,
  LEGACY_LANE_ALIASES,
  type CanonicalLaneId,
} from "../../../shared/terminology.js";

export { ACOPILOT_LANE_ID, ACTIONS_LANE_ID };

/** Legacy spellings kept for compatibility with persisted state and older clients. */
export const ADVISOR_LANE_ID = "advisor";
export const WORKER_LANE_ID = "worker";
export const LEGACY_ADVISOR_LANE_ID = "planner";

/**
 * Resolve a lane id, tolerating legacy spellings.
 *
 * Unlike the shared `normalizeLaneId`, an unrecognised value is passed through
 * rather than rejected. Callers here key preferences and storage off the result
 * and supply their own defaults, so changing this to fail closed would silently
 * change how unknown persisted lanes are stored. Use the shared normalizer where
 * a lane slot must reject unknown input.
 */
export function normalizeLaneId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  const canonical = LEGACY_LANE_ALIASES[normalized as keyof typeof LEGACY_LANE_ALIASES];
  return canonical ?? normalized;
}

/** Primary id first, then the legacy variants when applicable. */
export function laneIdVariants(value: unknown): string[] {
  const normalized = normalizeLaneId(value);
  if (!normalized) return [];
  const isCanonicalLane = normalized === ACOPILOT_LANE_ID || normalized === ACTIONS_LANE_ID;
  if (!isCanonicalLane) return [normalized];
  const aliases = Object.keys(LEGACY_LANE_ALIASES)
    .filter((alias) => LEGACY_LANE_ALIASES[alias as keyof typeof LEGACY_LANE_ALIASES] === normalized);
  return [normalized as CanonicalLaneId, ...aliases];
}

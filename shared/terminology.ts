/**
 * Canonical ADS lane and Actions-role terminology.
 *
 * This module is the single source of truth for the values that the rest of the
 * system writes. The web client consumes it today; the server adopts it in a
 * later slice, so it must stay dependency-free and free of Node or DOM APIs
 * until then.
 *
 * Three categories of value must never be conflated:
 *
 * 1. Canonical values   - what the application writes today.
 * 2. Legacy aliases     - what older clients and older rows may still contain.
 * 3. Persisted keys     - storage identifiers such as `web-planner` and
 *                         historical session ids, which are resolved but never
 *                         rewritten in place. Those are deliberately absent here;
 *                         see docs/adr/0027.
 *
 * Two prohibitions are encoded structurally rather than by convention:
 *
 * - `Reviewer` is an Actions execution role, never a top-level chat lane. The
 *   two vocabularies are separate types with separate normalizers, so a lane
 *   slot cannot accept "reviewer" and a role slot cannot accept "actions".
 * - There is no repository-wide textual replacement. Legacy values are only
 *   ever resolved through the explicit alias tables below.
 */

/**
 * The two canonical lane ids, named individually because call sites refer to a
 * specific lane far more often than they iterate the set. The array below is
 * derived from them so the two forms cannot drift.
 *
 * Note the absence of "reviewer": it is a role, not a lane.
 */
export const ACOPILOT_LANE_ID = "acopilot";
export const ACTIONS_LANE_ID = "actions";

export const CANONICAL_LANE_IDS = [ACOPILOT_LANE_ID, ACTIONS_LANE_ID] as const;
export type CanonicalLaneId = (typeof CANONICAL_LANE_IDS)[number];

/** Execution roles inside the Actions lane. */
export const ACTIONS_ROLE_IDS = ["developer", "reviewer"] as const;
export type ActionsRole = (typeof ACTIONS_ROLE_IDS)[number];

/**
 * Values the `role_profiles.role` column can hold.
 *
 * `acopilot` is a lane-level profile rather than an Actions role, and it shares
 * this column with the two Actions roles. That conflation is pre-existing and
 * persisted; splitting it is out of scope for the terminology contract.
 */
export const STORED_ROLE_PROFILE_VALUES = ["acopilot", "developer", "reviewer"] as const;
export type StoredRoleProfileValue = (typeof STORED_ROLE_PROFILE_VALUES)[number];

/**
 * Legacy lane values accepted on read, mapped to the lane they denote.
 *
 * `worker` is the Actions lane here. It denotes the Developer role only in
 * role-profile context; see LEGACY_ROLE_PROFILE_ALIASES for why the two differ.
 */
export const LEGACY_LANE_ALIASES = {
  advisor: "acopilot",
  planner: "acopilot",
  worker: "actions",
} as const satisfies Record<string, CanonicalLaneId>;

/**
 * Legacy role-profile values accepted on read.
 *
 * A stored `worker` profile describes the agent doing implementation work, so
 * it resolves to the `developer` role rather than to the `actions` lane. This is
 * the one place where the same legacy word means different things by context,
 * and conflating the two is exactly the split-brain the migration removes.
 */
export const LEGACY_ROLE_PROFILE_ALIASES = {
  advisor: "acopilot",
  worker: "developer",
} as const satisfies Record<string, StoredRoleProfileValue>;

export type LegacyLaneAlias = keyof typeof LEGACY_LANE_ALIASES;
export type LegacyRoleProfileAlias = keyof typeof LEGACY_ROLE_PROFILE_ALIASES;

const CANONICAL_LANE_SET: ReadonlySet<string> = new Set(CANONICAL_LANE_IDS);
const ACTIONS_ROLE_SET: ReadonlySet<string> = new Set(ACTIONS_ROLE_IDS);
const STORED_ROLE_PROFILE_SET: ReadonlySet<string> = new Set(STORED_ROLE_PROFILE_VALUES);

const asKey = (value: unknown): string => String(value ?? "").trim();

/**
 * Read a key from an alias table, ignoring inherited properties.
 *
 * The tables are plain object literals, so a bare index would resolve
 * `toString`, `constructor`, `__proto__` and friends to functions and objects
 * inherited from Object.prototype instead of reporting a miss. That would let
 * `normalizeLaneId("toString")` return a function while claiming to return a
 * lane id, breaking the fail-closed contract. Every alias lookup must go
 * through this helper.
 */
function lookupOwn(table: object, key: string): unknown {
  return Object.hasOwn(table, key) ? (table as Record<string, unknown>)[key] : undefined;
}

export function isCanonicalLaneId(value: unknown): value is CanonicalLaneId {
  return CANONICAL_LANE_SET.has(asKey(value));
}

export function isActionsRole(value: unknown): value is ActionsRole {
  return ACTIONS_ROLE_SET.has(asKey(value));
}

export function isStoredRoleProfileValue(value: unknown): value is StoredRoleProfileValue {
  return STORED_ROLE_PROFILE_SET.has(asKey(value));
}

/**
 * Resolve any accepted lane input to its canonical lane.
 *
 * Returns null for unknown input rather than passing the value through: a lane
 * slot must fail closed instead of silently routing to a lane that does not
 * exist. Callers that legitimately need to echo an unrecognised value must do
 * so explicitly rather than by relying on this function.
 */
export function normalizeLaneId(value: unknown): CanonicalLaneId | null {
  const key = asKey(value);
  if (CANONICAL_LANE_SET.has(key)) return key as CanonicalLaneId;
  return (lookupOwn(LEGACY_LANE_ALIASES, key) as CanonicalLaneId | undefined) ?? null;
}

/** Resolve any accepted Actions-role input. Fails closed on unknown input. */
export function normalizeActionsRole(value: unknown): ActionsRole | null {
  const key = asKey(value);
  return ACTIONS_ROLE_SET.has(key) ? (key as ActionsRole) : null;
}

/** Resolve any accepted `role_profiles.role` input. Fails closed on unknown input. */
export function normalizeStoredRoleProfileValue(value: unknown): StoredRoleProfileValue | null {
  const key = asKey(value);
  if (STORED_ROLE_PROFILE_SET.has(key)) return key as StoredRoleProfileValue;
  return (lookupOwn(LEGACY_ROLE_PROFILE_ALIASES, key) as StoredRoleProfileValue | undefined) ?? null;
}

/**
 * Every spelling that can denote a lane, canonical first.
 *
 * A canonical input expands to the canonical value followed by its legacy
 * aliases. Any other input -- a legacy alias, or a value that denotes no lane
 * at all -- is echoed back unchanged as a single element; this helper does not
 * resolve aliases on its own. Callers that want the full expansion for an alias
 * must normalize first, as the client helper does.
 *
 * Read paths use this to try each key in turn; write paths must use only the
 * canonical value. The order is stable so storage lookups are deterministic.
 */
export function laneIdVariants(value: unknown): string[] {
  const key = asKey(value);
  if (!key) return [];
  if (CANONICAL_LANE_SET.has(key)) {
    return [key, ...Object.keys(LEGACY_LANE_ALIASES).filter((alias) => LEGACY_LANE_ALIASES[alias as LegacyLaneAlias] === key)];
  }
  return [key];
}

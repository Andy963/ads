import type { CanonicalLaneId } from "../../../shared/terminology.js";

/**
 * Role-profile values as the API stores and reports them.
 *
 * This is the shared `StoredRoleProfileValue`, not a client-local copy: the
 * `role_profiles.role` column holds a lane-level `acopilot` profile alongside
 * the two Actions roles, which is why it is a distinct vocabulary from
 * `ActionsRole`. See ADR 0027.
 */
export type { StoredRoleProfileValue } from "../../../shared/terminology.js";

export type AuthStatus = {
  initialized: boolean;
};

export type AuthMe = {
  id: string;
  username: string;
};

export interface Attachment {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  filename?: string | null;
}

export interface ModelConfig {
  id: string;
  modelId?: string | null;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
}

/**
 * Lane identifiers as the API reports them.
 *
 * The server writes only canonical lane ids (see ADR 0027), so this is the
 * shared `CanonicalLaneId` rather than a client-local copy. Legacy spellings
 * never appear in a response; they are resolved at the boundary instead.
 */
export type LaneName = CanonicalLaneId;

export interface LanePromptVersion {
  lane: LaneName;
  version: number;
  prompt: string;
  isBase: boolean;
  createdAt: number;
}

export interface LanePromptSnapshot {
  lane: LaneName;
  current: LanePromptVersion;
  base: LanePromptVersion;
  versions: LanePromptVersion[];
  updatedAt: number;
}

export type SyncEvent = {
  seq: number;
  type: string;
  eventId?: string | null;
  revision: number;
  ts: number;
  runId?: string | null;
  payload: Record<string, unknown>;
};

export type SyncEventsResponse = {
  laneGeneration?: number;
  events: SyncEvent[];
  latestSeq: number;
  minAvailableSeq: number;
  hasMore: boolean;
  truncated: boolean;
  snapshot?: Record<string, unknown> | null;
};

/**
 * Retention classes for the web sync event log.
 *
 * Every broadcast frame used to occupy one `sync_events` row competing for a single
 * per-lane window. In practice streaming noise (`delta`, `command`, `explored`,
 * `patch`) accounted for ~94% of the rows and evicted the conversation events that
 * catch-up actually needs, so reconnects degraded to `truncated` full snapshots.
 *
 * Events are now graded:
 *
 * - `durable`   — conversation state. Full quota; trimming one advances the lane's
 *                 `trimmed_through` watermark so clients fall back to a snapshot.
 * - `ephemeral` — command/patch decoration kept in a separate, smaller quota.
 *                 Trimming it does not evict conversation text, but a cursor
 *                 that missed it needs history rather than a cursor-only resume.
 * - `transient` — never persisted. Per-token `delta` frames are represented in the
 *                 log by a single coalesced `delta_snapshot`; current-state control
 *                 snapshots such as `agents` are rebuilt during every bootstrap.
 */
export type SyncEventClass = "durable" | "ephemeral" | "transient";

export const DELTA_SNAPSHOT_EVENT_TYPE = "delta_snapshot";

/** Live-only frames. Broadcast immediately, never written to the replay log. */
export const TRANSIENT_SYNC_EVENT_TYPES: readonly string[] = ["delta", "agents"];

/** Decoration reproducible from history when its replay window has expired. */
export const EPHEMERAL_SYNC_EVENT_TYPES: readonly string[] = [
  "command",
  "command_snapshot",
  "explored",
  "patch",
  "workspace",
];

const TRANSIENT_EVENT_TYPES = new Set<string>(TRANSIENT_SYNC_EVENT_TYPES);

const EPHEMERAL_EVENT_TYPES = new Set<string>(EPHEMERAL_SYNC_EVENT_TYPES);

export function classifySyncEvent(eventType: string): SyncEventClass {
  const normalized = String(eventType ?? "").trim();
  if (!normalized) return "durable";
  if (TRANSIENT_EVENT_TYPES.has(normalized)) return "transient";
  if (EPHEMERAL_EVENT_TYPES.has(normalized)) return "ephemeral";
  return "durable";
}

export function isTransientSyncEvent(eventType: string): boolean {
  return classifySyncEvent(eventType) === "transient";
}

/** Terminal frames that end a streaming turn and retire its `delta_snapshot`. */
const STREAM_TERMINAL_EVENT_TYPES = new Set<string>(["result", "error"]);

export function isStreamTerminalEvent(eventType: string): boolean {
  return STREAM_TERMINAL_EVENT_TYPES.has(String(eventType ?? "").trim());
}

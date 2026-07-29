import type { SyncEventStore } from "./store.js";
import { DELTA_SNAPSHOT_EVENT_TYPE } from "./eventClass.js";

/**
 * How often the accumulated stream text is written to the sync log. Per-token
 * frames are broadcast live; only this throttled snapshot is persisted, so a
 * long answer costs one row instead of thousands.
 */
export const DELTA_SNAPSHOT_FLUSH_INTERVAL_MS = 750;

/** Upper bound on persisted stream text, so one runaway turn cannot bloat the lane. */
export const DELTA_SNAPSHOT_MAX_CHARS = 200_000;

export type DeltaStreamCoalescer = ReturnType<typeof createDeltaStreamCoalescer>;

/**
 * Collapses a stream of `delta` frames into a single coalesced `delta_snapshot`
 * row that always carries the text accumulated so far.
 *
 * This is what makes an in-flight turn resumable: a client reconnecting mid-stream
 * catches up to the snapshot instead of losing everything emitted while it was gone.
 * The row is retired once the turn reaches a terminal frame, because from that
 * point the durable `result` / `error` event and the history bootstrap carry the text.
 */
export function createDeltaStreamCoalescer(args: {
  store: Pick<SyncEventStore, "appendCoalesced" | "deleteCoalesced">;
  namespace: string;
  laneKey: string;
  flushIntervalMs?: number;
  maxChars?: number;
  now?: () => number;
}) {
  const flushIntervalMs = Math.max(0, args.flushIntervalMs ?? DELTA_SNAPSHOT_FLUSH_INTERVAL_MS);
  const maxChars = Math.max(1, args.maxChars ?? DELTA_SNAPSHOT_MAX_CHARS);
  const now = args.now ?? (() => Date.now());
  const eventId = `stream:${args.laneKey}`;

  let text = "";
  let revision = 0;
  let lastFlushAt = 0;
  let pending = false;

  const writeSnapshot = (): void => {
    revision += 1;
    pending = false;
    lastFlushAt = now();
    args.store.appendCoalesced({
      namespace: args.namespace,
      laneKey: args.laneKey,
      type: DELTA_SNAPSHOT_EVENT_TYPE,
      eventId,
      revision,
      payload: { type: DELTA_SNAPSHOT_EVENT_TYPE, text, revision },
      ts: lastFlushAt,
    });
  };

  return {
    /** Accumulate one live frame. Persists a snapshot at most once per interval. */
    appendDelta(delta: string): void {
      const chunk = String(delta ?? "");
      if (!chunk) return;
      text = (text + chunk).slice(-maxChars);
      pending = true;
      if (now() - lastFlushAt >= flushIntervalMs) {
        writeSnapshot();
      }
    },

    /** Force out anything still buffered (used before a terminal frame is logged). */
    flush(): void {
      if (!pending || !text) return;
      writeSnapshot();
    },

    /** Retire the snapshot once the turn is over; the terminal event supersedes it. */
    finish(): void {
      const hadStream = Boolean(text) || revision > 0;
      text = "";
      revision = 0;
      lastFlushAt = 0;
      pending = false;
      if (!hadStream) return;
      args.store.deleteCoalesced({
        namespace: args.namespace,
        laneKey: args.laneKey,
        type: DELTA_SNAPSHOT_EVENT_TYPE,
        eventId,
      });
    },

    /** Accumulated text so far — exposed for tests and diagnostics. */
    getText(): string {
      return text;
    },
  };
}

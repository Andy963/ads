import { randomUUID } from "node:crypto";

import type { SyncEventStore } from "./store.js";
import { DELTA_SNAPSHOT_EVENT_TYPE } from "./eventClass.js";

/** How often accumulated stream text is written to the sync log. */
export const DELTA_SNAPSHOT_FLUSH_INTERVAL_MS = 750;

/** Upper bound of persisted stream text for one assistant phase. */
export const DELTA_SNAPSHOT_MAX_CHARS = 200_000;

export type DeltaStreamCoalescer = ReturnType<typeof createDeltaStreamCoalescer>;

export type DeltaStreamPosition = {
  streamId: string;
  startOffset: number;
  endOffset: number;
  snapshotSeq: number | null;
};

export type DeltaStreamSnapshot = {
  type: typeof DELTA_SNAPSHOT_EVENT_TYPE;
  eventId: string;
  snapshotSeq: number | null;
  revision: number;
  active: boolean;
  afterSeq: number;
  streamId: string;
  text: string;
  startOffset: number;
  endOffset: number;
  ts: number;
};

type CoalescerStore = Pick<SyncEventStore, "appendCoalesced" | "deleteCoalesced"> & {
  readCoalesced?: (args: { namespace: string; laneKey: string; type?: string }) => Array<{
    seq: number;
    eventId?: string;
    revision: number;
    payload: Record<string, unknown>;
    ts: number;
  }>;
  markCoalescedInactive?: (args: {
    namespace: string;
    laneKey: string;
    type: string;
    eventId: string;
  }) => void;
};

function normalizeTimestamp(value: unknown, fallback: () => number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : fallback();
}

function parsePhase(eventId: string): number {
  const match = String(eventId ?? "").match(/:(\d+)$/);
  return match ? Math.max(0, Number(match[1])) : 0;
}

/**
 * Coalesces transient assistant deltas into one replayable snapshot per phase.
 *
 * The WebSocket server keeps one instance per logical lane. A second
 * connection therefore observes the same offsets and snapshot row instead of
 * starting an unrelated stream. `hydrate` continues an active row after a
 * process-level reconnect.
 */
export function createDeltaStreamCoalescer(args: {
  store: CoalescerStore;
  namespace: string;
  laneKey: string;
  flushIntervalMs?: number;
  maxChars?: number;
  now?: () => number;
  initialPhase?: number;
  hydrate?: boolean;
}) {
  const flushIntervalMs = Math.max(0, args.flushIntervalMs ?? DELTA_SNAPSHOT_FLUSH_INTERVAL_MS);
  const maxChars = Math.max(1, args.maxChars ?? DELTA_SNAPSHOT_MAX_CHARS);
  const now = args.now ?? (() => Date.now());
  const streamToken = randomUUID();

  let currentPhase = Math.max(0, args.initialPhase ?? 0);
  let activeEventId = `stream:${args.laneKey}:${streamToken}:${currentPhase}`;
  let text = "";
  let totalChars = 0;
  let revision = 0;
  let startedAt = 0;
  let lastFlushAt = 0;
  let latestSnapshotSeq: number | null = null;
  let pending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let hydrated = false;

  const clearFlushTimer = (): void => {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const scheduleFlush = (): void => {
    if (flushIntervalMs <= 0 || !pending || flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (pending) writeSnapshot(true);
    }, flushIntervalMs);
    flushTimer.unref?.();
  };

  const writeSnapshot = (active: boolean): number | null => {
    if (!text) return latestSnapshotSeq;
    revision += 1;
    pending = false;
    clearFlushTimer();
    lastFlushAt = now();
    const snapshotSeq = args.store.appendCoalesced({
      namespace: args.namespace,
      laneKey: args.laneKey,
      type: DELTA_SNAPSHOT_EVENT_TYPE,
      eventId: activeEventId,
      revision,
      payload: {
        type: DELTA_SNAPSHOT_EVENT_TYPE,
        text,
        revision,
        streamId: activeEventId,
        startOffset: Math.max(0, totalChars - text.length),
        endOffset: totalChars,
        ts: startedAt || lastFlushAt,
        active,
      },
      ts: lastFlushAt,
    });
    if (snapshotSeq !== null) latestSnapshotSeq = snapshotSeq;
    return snapshotSeq;
  };

  const hydrate = (): void => {
    if (hydrated || !args.hydrate || !args.store.readCoalesced) return;
    hydrated = true;
    const rows = args.store.readCoalesced({
      namespace: args.namespace,
      laneKey: args.laneKey,
      type: DELTA_SNAPSHOT_EVENT_TYPE,
    });
    if (rows.length === 0) return;

    const activeRows = rows.filter((row) => row.payload.active !== false);
    const row = activeRows.at(-1) ?? null;
    if (!row) {
      const highestPhase = rows.reduce(
        (highest, entry) => Math.max(highest, parsePhase(String(entry.eventId ?? ""))),
        currentPhase,
      );
      currentPhase = highestPhase + 1;
      return;
    }
    const payload = row.payload;
    const restoredText = String(payload.text ?? "");
    const restoredEnd = Number(payload.endOffset);
    const restoredStart = Number(payload.startOffset);
    if (!restoredText && !Number.isFinite(restoredEnd)) return;
    text = restoredText.slice(-maxChars);
    totalChars = Number.isFinite(restoredEnd) && restoredEnd >= 0
      ? Math.floor(restoredEnd)
      : Number.isFinite(restoredStart) && restoredStart >= 0
        ? Math.floor(restoredStart) + text.length
        : text.length;
    revision = Math.max(0, Math.floor(Number(payload.revision) || row.revision || 0));
    startedAt = normalizeTimestamp(payload.ts, () => row.ts || now());
    lastFlushAt = row.ts || now();
    latestSnapshotSeq = Number.isFinite(row.seq) && row.seq > 0 ? Math.floor(row.seq) : null;
    activeEventId = String(payload.streamId ?? row.eventId ?? activeEventId).trim() || activeEventId;
    currentPhase = parsePhase(activeEventId);
    pending = false;
  };

  hydrate();

  return {
    /** Accumulate one live frame and return its absolute stream interval. */
    appendDelta(delta: string, eventTs?: number): DeltaStreamPosition | null {
      const chunk = String(delta ?? "");
      if (!chunk) return null;
      if (!startedAt) startedAt = normalizeTimestamp(eventTs, now);
      const startOffset = totalChars;
      totalChars += chunk.length;
      text = (text + chunk).slice(-maxChars);
      pending = true;
      if (flushIntervalMs === 0 || now() - lastFlushAt >= flushIntervalMs) {
        writeSnapshot(true);
      } else {
        scheduleFlush();
      }
      return {
        streamId: activeEventId,
        startOffset,
        endOffset: totalChars,
        snapshotSeq: latestSnapshotSeq,
      };
    },

    /** Force out a pending snapshot before an ordering boundary. */
    flush(): void {
      if (pending && text) writeSnapshot(true);
    },

    /** Seal the current assistant phase while retaining it for catch-up. */
    finishPhase(): void {
      clearFlushTimer();
      if (pending && text) writeSnapshot(true);
      if (text && args.store.markCoalescedInactive) {
        args.store.markCoalescedInactive({
          namespace: args.namespace,
          laneKey: args.laneKey,
          type: DELTA_SNAPSHOT_EVENT_TYPE,
          eventId: activeEventId,
        });
      }
      text = "";
      totalChars = 0;
      revision = 0;
      startedAt = 0;
      lastFlushAt = 0;
      latestSnapshotSeq = null;
      pending = false;
      currentPhase += 1;
      activeEventId = `stream:${args.laneKey}:${streamToken}:${currentPhase}`;
    },

    /** Retire the currently active snapshot at terminal turn completion. */
    finish(): void {
      clearFlushTimer();
      const retiringEventId = activeEventId;
      const hadActive = Boolean(text) || revision > 0 || latestSnapshotSeq !== null;
      text = "";
      totalChars = 0;
      revision = 0;
      startedAt = 0;
      lastFlushAt = 0;
      latestSnapshotSeq = null;
      pending = false;
      if (hadActive) {
        currentPhase += 1;
        args.store.deleteCoalesced({
          namespace: args.namespace,
          laneKey: args.laneKey,
          type: DELTA_SNAPSHOT_EVENT_TYPE,
          eventId: retiringEventId,
        });
      }
      activeEventId = `stream:${args.laneKey}:${streamToken}:${currentPhase}`;
    },

    /** Reset in-memory state; durable rows are intentionally left untouched. */
    reset(): void {
      clearFlushTimer();
      text = "";
      totalChars = 0;
      revision = 0;
      startedAt = 0;
      lastFlushAt = 0;
      latestSnapshotSeq = null;
      pending = false;
      currentPhase = 0;
      activeEventId = `stream:${args.laneKey}:${streamToken}:0`;
    },

    /** Return the active runtime snapshot, including its cursor barrier. */
    getSnapshot(): DeltaStreamSnapshot | null {
      hydrate();
      if (!text && revision <= 0 && latestSnapshotSeq === null) return null;
      return {
        type: DELTA_SNAPSHOT_EVENT_TYPE,
        eventId: activeEventId,
        snapshotSeq: latestSnapshotSeq,
        revision,
        active: true,
        afterSeq: latestSnapshotSeq ?? 0,
        streamId: activeEventId,
        text,
        startOffset: Math.max(0, totalChars - text.length),
        endOffset: totalChars,
        ts: startedAt || lastFlushAt || now(),
      };
    },
    getSnapshots(): DeltaStreamSnapshot[] {
      const snapshot = this.getSnapshot();
      return snapshot ? [snapshot] : [];
    },
    getText: () => text,
    getPhase: () => currentPhase,
  };
}

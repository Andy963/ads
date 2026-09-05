import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../../../state/database.js";
import { createLogger } from "../../../utils/logger.js";
import { EPHEMERAL_SYNC_EVENT_TYPES } from "./eventClass.js";

type SqliteStatement = StatementType<unknown[], unknown>;

type TrimStatements = {
  cutoff: SqliteStatement;
  maxDeleted: SqliteStatement;
  deleteOlder: SqliteStatement;
  /** Values bound to the class predicate's placeholders, between lane_key and the trailing bound. */
  classParams: string[];
};

export type SyncEventRow = {
  seq: number;
  namespace: string;
  laneKey: string;
  type: string;
  eventId?: string;
  revision: number;
  payload: Record<string, unknown>;
  ts: number;
  runId?: string;
};

export type SyncEventReadResult = {
  events: SyncEventRow[];
  latestSeq: number;
  minAvailableSeq: number;
  hasMore: boolean;
  truncated: boolean;
};

export type CoalescedSyncEventRow = SyncEventRow;

const logger = createLogger("SyncEventStore");

function normalizeLimit(value: number | undefined): number {
  const limit = Number.isFinite(value) ? Math.floor(value as number) : 500;
  return Math.min(1000, Math.max(1, limit));
}

function normalizeSeq(value: number | undefined): number {
  const seq = Number.isFinite(value) ? Math.floor(value as number) : 0;
  return Math.max(0, seq);
}

function safeParsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class SyncEventStore {
  private readonly db: DatabaseType;
  private readonly maxEventsPerLane: number;
  private readonly maxEphemeralEventsPerLane: number;
  private readonly insertStmt: SqliteStatement;
  private readonly latestSeqStmt: SqliteStatement;
  private readonly minSeqStmt: SqliteStatement;
  private readonly upsertTrimmedThroughStmt: SqliteStatement;
  private readonly trimmedThroughStmt: SqliteStatement;
  private readonly deleteCoalescedStmt: SqliteStatement;
  private readonly durableTrim: TrimStatements;
  private readonly ephemeralTrim: TrimStatements;

  constructor(
    options: { stateDbPath?: string; maxEventsPerLane?: number; maxEphemeralEventsPerLane?: number } = {},
  ) {
    this.db = getStateDatabase(options.stateDbPath);
    this.maxEventsPerLane = Math.max(1, options.maxEventsPerLane ?? 2000);
    this.maxEphemeralEventsPerLane = Math.max(1, options.maxEphemeralEventsPerLane ?? 300);
    this.insertStmt = this.db.prepare(
      `INSERT INTO sync_events
        (namespace, lane_key, event_type, event_id, revision, payload, ts, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.latestSeqStmt = this.db.prepare(
      `SELECT MAX(seq) AS seq
       FROM sync_events
       WHERE namespace = ? AND lane_key = ?`,
    );
    this.minSeqStmt = this.db.prepare(
      `SELECT MIN(seq) AS seq
       FROM sync_events
       WHERE namespace = ? AND lane_key = ?`,
    );
    this.upsertTrimmedThroughStmt = this.db.prepare(
      `INSERT INTO sync_lane_state (namespace, lane_key, trimmed_through_seq)
       VALUES (?, ?, ?)
       ON CONFLICT(namespace, lane_key) DO UPDATE SET
         trimmed_through_seq = MAX(sync_lane_state.trimmed_through_seq, excluded.trimmed_through_seq)`,
    );
    this.trimmedThroughStmt = this.db.prepare(
      `SELECT trimmed_through_seq AS seq
       FROM sync_lane_state
       WHERE namespace = ? AND lane_key = ?`,
    );
    this.deleteCoalescedStmt = this.db.prepare(
      `DELETE FROM sync_events
       WHERE namespace = ? AND lane_key = ? AND event_type = ? AND event_id = ?`,
    );

    // Durable and ephemeral events are trimmed against separate quotas so that a
    // burst of live decoration cannot evict conversation state from the window.
    const ephemeralPlaceholders = EPHEMERAL_SYNC_EVENT_TYPES.map(() => "?").join(", ");
    const ephemeralParams = [...EPHEMERAL_SYNC_EVENT_TYPES];
    this.ephemeralTrim = this.prepareTrimStatements(`event_type IN (${ephemeralPlaceholders})`, ephemeralParams);
    this.durableTrim = this.prepareTrimStatements(`event_type NOT IN (${ephemeralPlaceholders})`, ephemeralParams);
  }

  private prepareTrimStatements(classPredicate: string, classParams: string[]): TrimStatements {
    return {
      classParams,
      cutoff: this.db.prepare(
        `SELECT seq FROM sync_events
         WHERE namespace = ? AND lane_key = ? AND ${classPredicate}
         ORDER BY seq DESC
         LIMIT 1 OFFSET ?`,
      ),
      maxDeleted: this.db.prepare(
        `SELECT MAX(seq) AS seq FROM sync_events
         WHERE namespace = ? AND lane_key = ? AND ${classPredicate} AND seq < ?`,
      ),
      deleteOlder: this.db.prepare(
        `DELETE FROM sync_events
         WHERE namespace = ? AND lane_key = ? AND ${classPredicate} AND seq < ?`,
      ),
    };
  }

  append(args: {
    namespace: string;
    laneKey: string;
    type: string;
    payload: Record<string, unknown>;
    eventId?: string;
    revision?: number;
    runId?: string;
    ts?: number;
  }): number | null {
    const namespace = String(args.namespace ?? "").trim();
    const laneKey = String(args.laneKey ?? "").trim();
    const eventType = String(args.type ?? "").trim();
    if (!namespace || !laneKey || !eventType) return null;
    const eventId = String(args.eventId ?? "").trim() || null;
    const revision = Math.max(1, Math.floor(Number(args.revision) || 1));
    const ts = Math.max(1, Math.floor(Number(args.ts) || Date.now()));
    const runId = String(args.runId ?? "").trim() || null;
    let payload = "";
    try {
      payload = JSON.stringify(args.payload);
    } catch {
      return null;
    }

    try {
      const tx = this.db.transaction((): number | null => {
        const info = this.insertStmt.run(namespace, laneKey, eventType, eventId, revision, payload, ts, runId);
        const lastInsertRowid = (info as { lastInsertRowid?: unknown }).lastInsertRowid;
        const seq =
          typeof lastInsertRowid === "bigint"
            ? Number(lastInsertRowid)
            : typeof lastInsertRowid === "number"
              ? lastInsertRowid
              : null;
        if (seq !== null && Number.isFinite(seq)) {
          this.trimLane(namespace, laneKey);
          return Math.floor(seq);
        }
        return null;
      });
      return tx();
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to append event`, error);
      return null;
    }
  }

  /**
   * Append an event that supersedes any previous one sharing the same
   * `(namespace, laneKey, type, eventId)`. The prior row is removed and a fresh
   * row inserted, so the event keeps exactly one slot in the lane while still
   * landing at a new (higher) `seq` — a client whose cursor is already past the
   * old row still receives the update on catch-up.
   *
   * Used for `delta_snapshot`: per-token streaming collapses to a single row that
   * always carries the latest accumulated text.
   */
  appendCoalesced(args: {
    namespace: string;
    laneKey: string;
    type: string;
    eventId: string;
    payload: Record<string, unknown>;
    revision?: number;
    runId?: string;
    ts?: number;
  }): number | null {
    const namespace = String(args.namespace ?? "").trim();
    const laneKey = String(args.laneKey ?? "").trim();
    const eventType = String(args.type ?? "").trim();
    const eventId = String(args.eventId ?? "").trim();
    if (!namespace || !laneKey || !eventType || !eventId) return null;
    const revision = Math.max(1, Math.floor(Number(args.revision) || 1));
    const ts = Math.max(1, Math.floor(Number(args.ts) || Date.now()));
    const runId = String(args.runId ?? "").trim() || null;
    let payload = "";
    try {
      payload = JSON.stringify(args.payload);
    } catch {
      return null;
    }

    try {
      const tx = this.db.transaction((): number | null => {
        this.deleteCoalescedStmt.run(namespace, laneKey, eventType, eventId);
        const info = this.insertStmt.run(namespace, laneKey, eventType, eventId, revision, payload, ts, runId);
        const lastInsertRowid = (info as { lastInsertRowid?: unknown }).lastInsertRowid;
        const seq =
          typeof lastInsertRowid === "bigint"
            ? Number(lastInsertRowid)
            : typeof lastInsertRowid === "number"
              ? lastInsertRowid
              : null;
        if (seq !== null && Number.isFinite(seq)) {
          this.trimLane(namespace, laneKey);
          return Math.floor(seq);
        }
        return null;
      });
      return tx();
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to append coalesced event`, error);
      return null;
    }
  }

  /** Retire a coalesced event (e.g. when a streaming turn reaches a terminal frame). */
  deleteCoalesced(args: { namespace: string; laneKey: string; type: string; eventId: string }): void {
    const namespace = String(args.namespace ?? "").trim();
    const laneKey = String(args.laneKey ?? "").trim();
    const eventType = String(args.type ?? "").trim();
    const eventId = String(args.eventId ?? "").trim();
    if (!namespace || !laneKey || !eventType || !eventId) return;
    try {
      this.deleteCoalescedStmt.run(namespace, laneKey, eventType, eventId);
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to delete coalesced event`, error);
    }
  }

  /** Mark a coalesced snapshot as sealed without allocating a new sequence. */
  markCoalescedInactive(args: { namespace: string; laneKey: string; type: string; eventId: string }): void {
    const namespace = String(args.namespace ?? "").trim();
    const laneKey = String(args.laneKey ?? "").trim();
    const eventType = String(args.type ?? "").trim();
    const eventId = String(args.eventId ?? "").trim();
    if (!namespace || !laneKey || !eventType || !eventId) return;
    try {
      const row = this.db
        .prepare(
          `SELECT payload FROM sync_events
           WHERE namespace = ? AND lane_key = ? AND event_type = ? AND event_id = ?
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(namespace, laneKey, eventType, eventId) as { payload?: string } | undefined;
      if (!row?.payload) return;
      const payload = safeParsePayload(row.payload);
      payload.active = false;
      this.db
        .prepare(
          `UPDATE sync_events SET payload = ?
           WHERE namespace = ? AND lane_key = ? AND event_type = ? AND event_id = ?`,
        )
        .run(JSON.stringify(payload), namespace, laneKey, eventType, eventId);
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to mark coalesced event inactive`, error);
    }
  }

  /**
   * Read the current coalesced rows for one lane. Coalesced rows are runtime
   * snapshots (for example an in-flight assistant stream or command), so they
   * need a direct lookup rather than a cursor-relative replay query.
   */
  readCoalesced(args: {
    namespace: string;
    laneKey: string;
    type?: string;
  }): CoalescedSyncEventRow[] {
    const namespace = String(args.namespace ?? "").trim();
    const laneKey = String(args.laneKey ?? "").trim();
    const type = String(args.type ?? "").trim();
    if (!namespace || !laneKey) return [];
    const whereType = type ? " AND event_type = ?" : "";
    const params = type ? [namespace, laneKey, type] : [namespace, laneKey];
    try {
      const rows = this.db
        .prepare(
          `SELECT seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id
           FROM sync_events
           WHERE namespace = ? AND lane_key = ?${whereType}
           ORDER BY seq ASC`,
        )
        .all(...params) as Array<{
        seq: number;
        namespace: string;
        lane_key: string;
        event_type: string;
        event_id: string | null;
        revision: number;
        payload: string;
        ts: number;
        run_id: string | null;
      }>;
      return rows.map((row) => ({
        seq: Number(row.seq) || 0,
        namespace: row.namespace,
        laneKey: row.lane_key,
        type: row.event_type,
        eventId: row.event_id ?? undefined,
        revision: Number(row.revision) || 1,
        payload: safeParsePayload(row.payload),
        ts: Number(row.ts) || 0,
        runId: row.run_id ?? undefined,
      }));
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to read coalesced events`, error);
      return [];
    }
  }

  /** Remove every coalesced row of a type for one lane. */
  deleteCoalescedByType(args: { namespace: string; laneKey: string; type: string }): void {
    const namespace = String(args.namespace ?? "").trim();
    const laneKey = String(args.laneKey ?? "").trim();
    const type = String(args.type ?? "").trim();
    if (!namespace || !laneKey || !type) return;
    try {
      this.db
        .prepare(`DELETE FROM sync_events WHERE namespace = ? AND lane_key = ? AND event_type = ?`)
        .run(namespace, laneKey, type);
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to delete coalesced events`, error);
    }
  }

  /** Remove replay rows and their truncation watermark when a lane is reset. */
  clearLanes(args: { namespace: string; laneKeys: string[] }): void {
    const namespace = String(args.namespace ?? "").trim();
    const laneKeys = [...new Set(args.laneKeys.map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (!namespace || laneKeys.length === 0) return;

    const placeholders = laneKeys.map(() => "?").join(", ");
    try {
      const clear = this.db.transaction(() => {
        this.db
          .prepare(`DELETE FROM sync_events WHERE namespace = ? AND lane_key IN (${placeholders})`)
          .run(namespace, ...laneKeys);
        this.db
          .prepare(`DELETE FROM sync_lane_state WHERE namespace = ? AND lane_key IN (${placeholders})`)
          .run(namespace, ...laneKeys);
      });
      clear();
    } catch (error) {
      logger.warn(`[SyncEventStore] Failed to clear lanes`, error);
    }
  }

  readAfter(args: {
    namespace: string;
    laneKey: string;
    afterSeq?: number;
    limit?: number;
  }): SyncEventReadResult {
    return this.readAfterLanes({
      namespace: args.namespace,
      laneKeys: [args.laneKey],
      afterSeq: args.afterSeq,
      limit: args.limit,
    });
  }

  readAfterLanes(args: {
    namespace: string;
    laneKeys: string[];
    afterSeq?: number;
    limit?: number;
  }): SyncEventReadResult {
    const namespace = String(args.namespace ?? "").trim();
    const laneKeys = [...new Set(args.laneKeys.map((value) => String(value ?? "").trim()).filter(Boolean))];
    const afterSeq = normalizeSeq(args.afterSeq);
    const limit = normalizeLimit(args.limit);
    if (!namespace || laneKeys.length === 0) {
      return { events: [], latestSeq: 0, minAvailableSeq: 0, hasMore: false, truncated: false };
    }
    const latestSeq = this.getLatestSeqForLanes(namespace, laneKeys);
    const minAvailableSeq = this.getMinSeqForLanes(namespace, laneKeys);
    const truncated = laneKeys.some((laneKey) => this.getTrimmedThroughSeq(namespace, laneKey) > afterSeq);
    const placeholders = laneKeys.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id
       FROM sync_events
       WHERE namespace = ? AND lane_key IN (${placeholders}) AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    ).all(namespace, ...laneKeys, afterSeq, limit + 1) as Array<{
      seq: number;
      namespace: string;
      lane_key: string;
      event_type: string;
      event_id: string | null;
      revision: number;
      payload: string;
      ts: number;
      run_id: string | null;
    }>;
    const sliced = rows.slice(0, limit);
    return {
      events: sliced.map((row) => ({
        seq: Number(row.seq) || 0,
        namespace: row.namespace,
        laneKey: row.lane_key,
        type: row.event_type,
        eventId: row.event_id ?? undefined,
        revision: Number(row.revision) || 1,
        payload: safeParsePayload(row.payload),
        ts: Number(row.ts) || 0,
        runId: row.run_id ?? undefined,
      })),
      latestSeq,
      minAvailableSeq,
      hasMore: rows.length > limit,
      truncated,
    };
  }

  getLatestSeq(namespace: string, laneKey: string): number {
    const row = this.latestSeqStmt.get(namespace, laneKey) as { seq?: number | null } | undefined;
    return Number(row?.seq) || 0;
  }

  getLatestSeqForLanes(namespace: string, laneKeys: string[]): number {
    const normalized = [...new Set(laneKeys.map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (!String(namespace ?? "").trim() || normalized.length === 0) return 0;
    return normalized.reduce((latest, laneKey) => Math.max(latest, this.getLatestSeq(namespace, laneKey)), 0);
  }

  private getMinSeq(namespace: string, laneKey: string): number {
    const row = this.minSeqStmt.get(namespace, laneKey) as { seq?: number | null } | undefined;
    return Number(row?.seq) || 0;
  }

  private getMinSeqForLanes(namespace: string, laneKeys: string[]): number {
    let minimum = 0;
    for (const laneKey of laneKeys) {
      const candidate = this.getMinSeq(namespace, laneKey);
      if (candidate > 0 && (minimum === 0 || candidate < minimum)) {
        minimum = candidate;
      }
    }
    return minimum;
  }

  private getTrimmedThroughSeq(namespace: string, laneKey: string): number {
    const row = this.trimmedThroughStmt.get(namespace, laneKey) as { seq?: number | null } | undefined;
    return Number(row?.seq) || 0;
  }

  private trimLane(namespace: string, laneKey: string): void {
    // Ephemeral decoration is dropped silently: the `history` bootstrap already
    // reproduces it, so losing it must not push clients onto the truncated path.
    this.trimClass(namespace, laneKey, this.ephemeralTrim, this.maxEphemeralEventsPerLane, false);
    // Losing durable conversation state is exactly what `truncated` exists to signal.
    this.trimClass(namespace, laneKey, this.durableTrim, this.maxEventsPerLane, true);
  }

  private trimClass(
    namespace: string,
    laneKey: string,
    statements: TrimStatements,
    keep: number,
    advanceTrimmedThrough: boolean,
  ): void {
    const classParams = statements.classParams;
    const cutoff = statements.cutoff.get(namespace, laneKey, ...classParams, Math.max(0, keep - 1)) as
      | { seq?: number }
      | undefined;
    const cutoffSeq = Number(cutoff?.seq) || 0;
    if (cutoffSeq <= 0) return;
    const deletedRow = statements.maxDeleted.get(namespace, laneKey, ...classParams, cutoffSeq) as
      | { seq?: number | null }
      | undefined;
    const trimmedThroughSeq = Number(deletedRow?.seq) || 0;
    if (trimmedThroughSeq <= 0) return;
    statements.deleteOlder.run(namespace, laneKey, ...classParams, cutoffSeq);
    if (advanceTrimmedThrough) {
      this.upsertTrimmedThroughStmt.run(namespace, laneKey, trimmedThroughSeq);
    }
  }
}

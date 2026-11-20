import type { Database as DatabaseType } from "better-sqlite3";

import { createLogger } from "../utils/logger.js";

type SessionUsage = {
  namespace: string;
  sessionId: string;
  lastTs: number;
  storedBytes: number;
};

export interface HistoryMaintenanceOptions {
  retentionDays: number;
  maxStoredBytes: number;
}

export interface HistoryMaintenanceResult {
  deletedEntries: number;
  deletedSessions: number;
  remainingStoredBytes: number;
}

const logger = createLogger("HistoryMaintenance");
const DAY_MS = 24 * 60 * 60 * 1000;

function listSessionUsage(db: DatabaseType): SessionUsage[] {
  return db.prepare(
    `SELECT
       namespace,
       session_id AS sessionId,
       MAX(ts) AS lastTs,
       SUM(length(CAST(text AS BLOB))) AS storedBytes
     FROM history_entries
     GROUP BY namespace, session_id
     ORDER BY lastTs ASC`,
  ).all() as SessionUsage[];
}

export function runHistoryMaintenance(
  db: DatabaseType,
  options: HistoryMaintenanceOptions,
  now = Date.now(),
): HistoryMaintenanceResult {
  const retentionDays = Math.max(0, Math.floor(options.retentionDays));
  const maxStoredBytes = Math.max(0, Math.floor(options.maxStoredBytes));
  let deletedEntries = 0;
  let deletedSessions = 0;
  let remainingStoredBytes = 0;

  const tx = db.transaction(() => {
    let sessions = listSessionUsage(db);
    const sessionsToDelete = new Map<string, SessionUsage>();
    if (retentionDays > 0) {
      const cutoff = now - retentionDays * DAY_MS;
      for (const session of sessions) {
        if (session.lastTs < cutoff) {
          sessionsToDelete.set(`${session.namespace}\0${session.sessionId}`, session);
        }
      }
    }

    remainingStoredBytes = sessions.reduce((total, session) => total + session.storedBytes, 0);
    for (const session of sessionsToDelete.values()) {
      remainingStoredBytes -= session.storedBytes;
    }

    if (maxStoredBytes > 0 && remainingStoredBytes > maxStoredBytes) {
      const targetBytes = Math.floor(maxStoredBytes * 0.9);
      for (const session of sessions) {
        const key = `${session.namespace}\0${session.sessionId}`;
        if (sessionsToDelete.has(key)) {
          continue;
        }
        sessionsToDelete.set(key, session);
        remainingStoredBytes -= session.storedBytes;
        if (remainingStoredBytes <= targetBytes) {
          break;
        }
      }
    }

    const deleteHistory = db.prepare(
      "DELETE FROM history_entries WHERE namespace = ? AND session_id = ?",
    );
    const deleteLinks = db.prepare(
      "DELETE FROM history_session_links WHERE namespace = ? AND session_id = ?",
    );
    for (const session of sessionsToDelete.values()) {
      deletedEntries += deleteHistory.run(session.namespace, session.sessionId).changes;
      deleteLinks.run(session.namespace, session.sessionId);
      deletedSessions += 1;
    }

    db.prepare(
      `DELETE FROM history_session_links
       WHERE NOT EXISTS (
         SELECT 1
         FROM history_entries
         WHERE history_entries.namespace = history_session_links.namespace
           AND history_entries.session_id = history_session_links.session_id
       )`,
    ).run();

    sessions = listSessionUsage(db);
    remainingStoredBytes = sessions.reduce((total, session) => total + session.storedBytes, 0);
  });
  tx();

  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("optimize");
    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const freePages = Number(db.pragma("freelist_count", { simple: true }));
    if (deletedEntries > 0 && pageCount > 0 && freePages / pageCount >= 0.25) {
      db.exec("VACUUM");
    }
  } catch (error) {
    logger.warn(`[HistoryMaintenance] SQLite compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { deletedEntries, deletedSessions, remainingStoredBytes };
}

export class HistoryMaintenanceScheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseType,
    private readonly options: HistoryMaintenanceOptions,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer || this.intervalMs <= 0) {
      return;
    }
    this.run();
    this.timer = setInterval(() => this.run(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private run(): void {
    try {
      const result = runHistoryMaintenance(this.db, this.options);
      if (result.deletedEntries > 0) {
        logger.info(
          `[HistoryMaintenance] deletedSessions=${result.deletedSessions} deletedEntries=${result.deletedEntries} remainingBytes=${result.remainingStoredBytes}`,
        );
      }
    } catch (error) {
      logger.warn(`[HistoryMaintenance] Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

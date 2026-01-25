import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { Database as DatabaseType, Statement as StatementType } from 'better-sqlite3';

import { getStateDatabase } from '../../state/database.js';
import { resolveAdsStateDir } from '../../workspace/adsPaths.js';
import { createLogger } from '../../utils/logger.js';

interface ThreadStorageOptions {
  namespace?: string;
  storagePath?: string; // legacy json path
  saltPath?: string; // legacy salt file path
  stateDbPath?: string;
}

interface ThreadRecord {
  userHash: string;
  threadId: string;
  lastActivity: number;
  cwd?: string;
  namespace?: string;

  // Legacy fields
  userId?: number;
}

interface ThreadState {
  threadId?: string;
  cwd?: string;
  agentThreads?: Record<string, string>;
}

const logger = createLogger('ThreadStorage');

type SqliteStatement = StatementType<unknown[], unknown>;

export class ThreadStorage {
  private readonly namespace: string;
  private readonly legacyStoragePath: string;
  private readonly legacySaltPath: string;
  private readonly stateDbPath?: string;
  private readonly db: DatabaseType;
  private readonly salt: string;

  private readonly getStmt: SqliteStatement;
  private readonly upsertStmt: SqliteStatement;
  private readonly deleteStmt: SqliteStatement;
  private readonly clearNamespaceStmt: SqliteStatement;

  private readonly getKvStmt: SqliteStatement;
  private readonly setKvStmt: SqliteStatement;
  private readonly getMigrationMarkerStmt: SqliteStatement;
  private readonly setMigrationMarkerStmt: SqliteStatement;

  constructor(options: ThreadStorageOptions = {}) {
    this.namespace = options.namespace?.trim() || 'tg';
    const adsDir = resolveAdsStateDir();
    this.legacyStoragePath =
      options.storagePath ??
      path.join(adsDir, this.namespace === 'tg' ? 'telegram-threads.json' : `${this.namespace}-threads.json`);
    this.legacySaltPath = options.saltPath ?? path.join(adsDir, 'thread-storage-salt');
    this.stateDbPath = options.stateDbPath;
    this.db = getStateDatabase(this.stateDbPath);

    this.getStmt = this.db.prepare(
      `SELECT thread_id as threadId, cwd
       FROM thread_state
       WHERE namespace = ? AND user_hash = ?`,
    );
    this.upsertStmt = this.db.prepare(
      `INSERT INTO thread_state (namespace, user_hash, thread_id, cwd, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, user_hash)
       DO UPDATE SET thread_id = excluded.thread_id,
                     cwd = excluded.cwd,
                     updated_at = excluded.updated_at`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM thread_state WHERE namespace = ? AND user_hash = ?`,
    );
    this.clearNamespaceStmt = this.db.prepare(
      `DELETE FROM thread_state WHERE namespace = ?`,
    );

    this.getKvStmt = this.db.prepare(
      `SELECT value FROM kv_state WHERE namespace = ? AND key = ?`,
    );
    this.setKvStmt = this.db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.getMigrationMarkerStmt = this.db.prepare(
      `SELECT value FROM kv_state WHERE namespace = 'migrations' AND key = ?`,
    );
    this.setMigrationMarkerStmt = this.db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES ('migrations', ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );

    this.salt = this.loadSalt();
    this.migrateLegacyThreads();
  }

  private loadSalt(): string {
    const kvNamespace = 'thread_storage';
    const kvKey = 'salt';

    try {
      if (fs.existsSync(this.legacySaltPath)) {
        const existing = fs.readFileSync(this.legacySaltPath, 'utf-8').trim();
        if (existing) {
          this.persistSaltToDb(kvNamespace, kvKey, existing);
          return existing;
        }
      }
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to read legacy salt file ${this.legacySaltPath}`, error);
    }

    try {
      const row = this.getKvStmt.get(kvNamespace, kvKey) as { value?: string } | undefined;
      if (row?.value) {
        return String(row.value);
      }
    } catch (error) {
      logger.warn('[ThreadStorage] Failed to read salt from state.db', error);
    }

    const generated = crypto.randomBytes(32).toString('hex');
    this.persistSaltToDb(kvNamespace, kvKey, generated);

    try {
      fs.mkdirSync(path.dirname(this.legacySaltPath), { recursive: true });
      fs.writeFileSync(this.legacySaltPath, generated, 'utf-8');
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to persist legacy salt file ${this.legacySaltPath}`, error);
    }

    return generated;
  }

  private hashUserId(userId: number): string {
    return crypto.createHash('sha256').update(String(userId)).update(':').update(this.salt).digest('hex');
  }

  private persistSaltToDb(namespace: string, key: string, value: string): void {
    try {
      this.setKvStmt.run(namespace, key, value, Date.now());
    } catch (error) {
      logger.warn('[ThreadStorage] Failed to persist salt to state.db', error);
    }
  }

  private migrateLegacyThreads(): void {
    const legacyPath = this.legacyStoragePath ? path.resolve(this.legacyStoragePath) : '';
    if (!legacyPath || !fs.existsSync(legacyPath)) {
      return;
    }

    const marker = `threads:${this.namespace}:${path.basename(legacyPath)}`;
    try {
      const existing = this.getMigrationMarkerStmt.get(marker) as { value?: string } | undefined;
      if (existing?.value) {
        return;
      }
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to read migration marker ${marker}`, error);
    }

    try {
      const raw = fs.readFileSync(legacyPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const records = Array.isArray(parsed) ? (parsed as ThreadRecord[]) : [];

      const tx = this.db.transaction(() => {
        for (const record of records) {
          if (!record || typeof record !== 'object') {
            continue;
          }
          if (record.namespace && record.namespace !== this.namespace) {
            continue;
          }

          const userHash =
            typeof record.userHash === 'string' && record.userHash.trim()
              ? record.userHash.trim()
              : typeof record.userId === 'number'
                ? this.hashUserId(record.userId)
                : '';
          const threadId = typeof record.threadId === 'string' ? record.threadId.trim() : '';
          if (!userHash || !threadId) {
            continue;
          }
          const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd.trim() : null;
          this.upsertStmt.run(this.namespace, userHash, threadId, cwd, Date.now());
        }
      });
      tx();

      this.setMigrationMarkerStmt.run(marker, '1', Date.now());
      logger.info(`[ThreadStorage] Migrated legacy threads from ${legacyPath} -> state.db (${this.namespace})`);
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to migrate legacy threads ${legacyPath}`, error);
    }
  }

  private parseThreadIdValue(raw: string): { codex?: string; agentThreads: Record<string, string> } {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { agentThreads: {} };
    }
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const agentThreads: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string" && value.trim()) {
              agentThreads[key] = value.trim();
            }
          }
          return { codex: agentThreads.codex, agentThreads };
        }
      } catch {
        // fall back to legacy string format
      }
    }
    return { codex: trimmed, agentThreads: { codex: trimmed } };
  }

  private serializeThreadIdValue(state: ThreadState): string | null {
    const agentThreads: Record<string, string> = { ...(state.agentThreads ?? {}) };
    if (state.threadId) {
      agentThreads.codex = String(state.threadId).trim();
    }
    for (const [key, value] of Object.entries(agentThreads)) {
      if (!value || !value.trim()) {
        delete agentThreads[key];
      } else {
        agentThreads[key] = value.trim();
      }
    }
    const keys = Object.keys(agentThreads);
    if (keys.length === 0) {
      return null;
    }
    if (keys.length === 1 && keys[0] === "codex") {
      return agentThreads.codex ?? null;
    }
    return JSON.stringify(agentThreads);
  }

  getThreadId(userId: number, agentId = "codex"): string | undefined {
    const record = this.getRecord(userId);
    if (!record) {
      return undefined;
    }
    if (agentId === "codex") {
      return record.threadId ?? record.agentThreads?.codex;
    }
    return record.agentThreads?.[agentId];
  }

  setThreadId(userId: number, threadId: string, agentId = "codex"): void {
    const existing = this.getRecord(userId);
    const agentThreads = { ...(existing?.agentThreads ?? {}) };
    const cleaned = String(threadId ?? "").trim();
    if (!cleaned) {
      return;
    }
    agentThreads[agentId] = cleaned;
    const codexId = agentThreads.codex ?? (agentId === "codex" ? cleaned : existing?.threadId);
    this.setRecord(userId, { threadId: codexId, cwd: existing?.cwd, agentThreads });
  }

  getRecord(userId: number): ThreadState | undefined {
    const userHash = this.hashUserId(userId);
    try {
      const row = this.getStmt.get(this.namespace, userHash) as
        | { threadId: string; cwd: string | null }
        | undefined;
      if (!row || !row.threadId) {
        return undefined;
      }
      const parsed = this.parseThreadIdValue(row.threadId);
      const cwd = row.cwd && typeof row.cwd === 'string' ? row.cwd : undefined;
      return { threadId: parsed.codex, cwd, agentThreads: parsed.agentThreads };
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to read thread record (ns=${this.namespace})`, error);
      return undefined;
    }
  }

  setRecord(userId: number, state: ThreadState): void {
    const userHash = this.hashUserId(userId);
    const threadId = this.serializeThreadIdValue(state);
    if (!threadId) {
      return;
    }
    const cwd = typeof state.cwd === 'string' && state.cwd.trim() ? state.cwd.trim() : null;
    try {
      this.upsertStmt.run(this.namespace, userHash, threadId, cwd, Date.now());
      logger.debug(
        `Saved state (ns=${this.namespace} thread=${threadId}${cwd ? `, cwd=${cwd}` : ''})`,
      );
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to persist thread record (ns=${this.namespace})`, error);
    }
  }

  removeThread(userId: number): void {
    const userHash = this.hashUserId(userId);
    try {
      this.deleteStmt.run(this.namespace, userHash);
      logger.debug('Removed thread');
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to remove thread (ns=${this.namespace})`, error);
    }
  }

  clear(): void {
    try {
      this.clearNamespaceStmt.run(this.namespace);
    } catch (error) {
      logger.warn(`[ThreadStorage] Failed to clear namespace threads (ns=${this.namespace})`, error);
    }
  }
}

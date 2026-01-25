import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { createLogger } from "./logger.js";

type SqliteStatement = StatementType<unknown[], unknown>;

export interface HistoryEntry {
  role: string;
  text: string;
  ts: number;
  kind?: string;
}

interface HistoryStoreOptions {
  namespace?: string;
  storagePath?: string;
  migrateFromPaths?: string[];
  maxEntriesPerSession?: number;
  maxTextLength?: number;
}

const logger = createLogger("HistoryStore");

function isSqlitePath(storagePath: string): boolean {
  const lowered = storagePath.trim().toLowerCase();
  return lowered.endsWith(".db") || lowered.endsWith(".sqlite") || lowered.endsWith(".sqlite3");
}

export class HistoryStore {
  private storagePath: string;
  private readonly namespace: string;
  private maxEntriesPerSession: number;
  private maxTextLength: number;
  private store = new Map<string, HistoryEntry[]>();
  private db: DatabaseType | null = null;
  private useSqlite = false;

  private insertStmt?: SqliteStatement;
  private selectStmt?: SqliteStatement;
  private deleteSessionStmt?: SqliteStatement;
  private cutoffStmt?: SqliteStatement;
  private deleteOlderStmt?: SqliteStatement;
  private getMigrationMarkerStmt?: SqliteStatement;
  private setMigrationMarkerStmt?: SqliteStatement;

  constructor(options: HistoryStoreOptions = {}) {
    this.storagePath =
      options.storagePath ??
      path.join(resolveAdsStateDir(), "state.db");
    this.namespace = options.namespace?.trim() || "default";
    this.maxEntriesPerSession = Math.max(1, options.maxEntriesPerSession ?? 200);
    this.maxTextLength = options.maxTextLength ?? 4000;
    this.useSqlite = isSqlitePath(this.storagePath);
    if (this.useSqlite) {
      this.db = getStateDatabase(this.storagePath);
      this.prepareSqliteStatements();
      this.migrateFromJsonFiles(options.migrateFromPaths);
    } else {
      this.load();
    }
  }

  get(sessionId: string): HistoryEntry[] {
    const normalizedKey = String(sessionId ?? "").trim();
    if (!normalizedKey) {
      return [];
    }
    if (!this.useSqlite || !this.db || !this.selectStmt) {
      return this.store.get(normalizedKey) ?? [];
    }
    const rows = this.selectStmt.all(this.namespace, normalizedKey) as Array<{
      role: string;
      text: string;
      ts: number;
      kind: string | null;
    }>;
    return rows.map((row) => ({
      role: row.role,
      text: row.text,
      ts: row.ts,
      kind: row.kind ?? undefined,
    }));
  }

  add(sessionId: string, entry: HistoryEntry): void {
    const normalized = this.normalize(entry);
    if (!normalized) return;
    const normalizedKey = String(sessionId ?? "").trim();
    if (!normalizedKey) {
      return;
    }

    if (!this.useSqlite || !this.db || !this.insertStmt) {
      const existing = this.store.get(normalizedKey) ?? [];
      existing.push(normalized);
      const trimmed = this.trim(existing);
      this.store.set(normalizedKey, trimmed);
      this.persist();
      return;
    }

    const tx = this.db.transaction(() => {
      this.insertStmt!.run(
        this.namespace,
        normalizedKey,
        normalized.role,
        normalized.text,
        normalized.ts,
        normalized.kind ?? null,
      );
      this.trimSqlite(normalizedKey);
    });
    try {
      tx();
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to insert history entry (sqlite)`, error);
      // Fallback to best-effort: do not throw in callers
    }
  }

  clear(sessionId: string): void {
    const normalizedKey = String(sessionId ?? "").trim();
    if (!normalizedKey) {
      return;
    }

    if (!this.useSqlite || !this.db || !this.deleteSessionStmt) {
      this.store.delete(normalizedKey);
      this.persist();
      return;
    }

    try {
      this.deleteSessionStmt.run(this.namespace, normalizedKey);
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to clear history session (sqlite)`, error);
    }
  }

  private normalize(entry: HistoryEntry): HistoryEntry | null {
    const role = String(entry.role || "").trim();
    const text = String(entry.text ?? "").trim();
    if (!role || !text) return null;
    const truncated =
      text.length > this.maxTextLength
        ? `${text.slice(0, this.maxTextLength - 1)}…`
        : text;
    const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
    const kind =
      entry.kind && typeof entry.kind === "string"
        ? entry.kind.trim() || undefined
        : undefined;
    return { role, text: truncated, ts, kind };
  }

  private trim(items: HistoryEntry[]): HistoryEntry[] {
    if (items.length <= this.maxEntriesPerSession) {
      return items;
    }
    return items.slice(items.length - this.maxEntriesPerSession);
  }

  private prepareSqliteStatements(): void {
    if (!this.db) {
      return;
    }
    this.insertStmt = this.db.prepare(
      `INSERT INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT role, text, ts, kind
       FROM history_entries
       WHERE namespace = ? AND session_id = ?
       ORDER BY id ASC`,
    );
    this.deleteSessionStmt = this.db.prepare(
      `DELETE FROM history_entries WHERE namespace = ? AND session_id = ?`,
    );
    this.cutoffStmt = this.db.prepare(
      `SELECT id FROM history_entries
       WHERE namespace = ? AND session_id = ?
       ORDER BY id DESC
       LIMIT 1 OFFSET ?`,
    );
    this.deleteOlderStmt = this.db.prepare(
      `DELETE FROM history_entries WHERE namespace = ? AND session_id = ? AND id < ?`,
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
  }

  private trimSqlite(sessionId: string): void {
    if (!this.db || !this.cutoffStmt || !this.deleteOlderStmt) {
      return;
    }
    const offset = this.maxEntriesPerSession - 1;
    if (offset < 0) {
      return;
    }
    const row = this.cutoffStmt.get(this.namespace, sessionId, offset) as { id: number } | undefined;
    if (!row || !row.id) {
      return;
    }
    this.deleteOlderStmt.run(this.namespace, sessionId, row.id);
  }

  private migrateFromJsonFiles(paths?: string[]): void {
    if (!this.useSqlite || !this.db || !this.insertStmt || !paths || paths.length === 0) {
      return;
    }

    for (const legacyPath of paths) {
      const resolved = legacyPath ? path.resolve(legacyPath) : "";
      if (!resolved || !fs.existsSync(resolved)) {
        continue;
      }

      const marker = `history:${this.namespace}:${path.basename(resolved)}`;
      try {
        const existing = this.getMigrationMarkerStmt?.get(marker) as { value?: string } | undefined;
        if (existing?.value) {
          continue;
        }
      } catch (error) {
        logger.warn(`[HistoryStore] Failed to read migration marker ${marker}`, error);
      }

      try {
        const raw = fs.readFileSync(resolved, "utf8");
        const parsed = JSON.parse(raw) as Record<string, HistoryEntry[]>;
        const tx = this.db.transaction(() => {
          for (const [sessionId, entries] of Object.entries(parsed ?? {})) {
            if (!Array.isArray(entries) || entries.length === 0) {
              continue;
            }
            const normalizedKey = String(sessionId ?? "").trim();
            if (!normalizedKey) {
              continue;
            }
            for (const entry of entries) {
              const normalized = this.normalize(entry);
              if (!normalized) {
                continue;
              }
              this.insertStmt!.run(
                this.namespace,
                normalizedKey,
                normalized.role,
                normalized.text,
                normalized.ts,
                normalized.kind ?? null,
              );
            }
            this.trimSqlite(normalizedKey);
          }
        });
        tx();
        this.setMigrationMarkerStmt?.run(marker, "1", Date.now());
        logger.info(`[HistoryStore] Migrated legacy history from ${resolved} -> state.db (${this.namespace})`);
      } catch (error) {
        logger.warn(`[HistoryStore] Failed to migrate legacy history ${resolved}`, error);
      }
    }
  }

  private load(): void {
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, HistoryEntry[]>;
      const next = new Map<string, HistoryEntry[]>();
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (!Array.isArray(value)) continue;
        const entries: HistoryEntry[] = [];
        for (const item of value) {
          const normalized = this.normalize(item);
          if (normalized) {
            entries.push(normalized);
          }
        }
        if (entries.length > 0) {
          next.set(key, this.trim(entries));
        }
      }
      this.store = next;
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to load ${this.storagePath}, resetting`, error);
      this.store = new Map();
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storagePath);
      fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, HistoryEntry[]> = {};
      for (const [key, items] of this.store.entries()) {
        obj[key] = this.trim(items);
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(obj, null, 2), "utf8");
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to persist ${this.storagePath}`, error);
    }
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { prepareMigrationMarkerStatements } from "../state/migrations.js";
import {
  getHistoryClientMessageId,
  mergePromptExecutionMetadataIntoKind,
  sameHistoryClientMessageKind,
  type PromptExecutionMetadata,
} from "./historyKind.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { parseBooleanFlag } from "./flags.js";
import { createLogger } from "./logger.js";
import { isSqliteDbPath } from "./sqlitePaths.js";
import { truncateForLog } from "./text.js";

type SqliteStatement = StatementType<unknown[], unknown>;

type HistoryStoreStatements = {
  insertStmt: SqliteStatement;
  selectStmt: SqliteStatement;
  deleteSessionStmt: SqliteStatement;
  cutoffStmt: SqliteStatement;
  deleteOlderStmt: SqliteStatement;
  getMigrationMarkerStmt: SqliteStatement;
  setMigrationMarkerStmt: SqliteStatement;
  selectByClientMessageKindStmt: SqliteStatement;
  updateKindByIdStmt: SqliteStatement;
  selectIdByExactKindStmt: SqliteStatement;
  updateTextAndTsByIdStmt: SqliteStatement;
  deleteSessionLinksStmt: SqliteStatement;
  upsertSessionLinkStmt: SqliteStatement;
  selectSessionLinksStmt: SqliteStatement;
};

const historyStoreStatementsCache = new WeakMap<DatabaseType, HistoryStoreStatements>();

export interface HistoryEntry {
  role: string;
  text: string;
  ts: number;
  kind?: string;
}

export interface AgentSessionLink {
  agentId: string;
  providerSessionId: string;
  cwd?: string;
  locator?: {
    kind: string;
    root?: string;
    pattern?: string;
  };
  firstSeenAt: number;
  lastSeenAt: number;
}

interface HistoryStoreOptions {
  namespace?: string;
  storagePath?: string;
  migrateFromPaths?: string[];
  maxEntriesPerSession?: number;
  maxTextLength?: number;
}

const logger = createLogger("HistoryStore");

function resolveAgentSessionLocator(agentId: string): AgentSessionLink["locator"] {
  if (agentId === "codex") {
    return {
      kind: "codex_sessions",
      root: process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
      pattern: "sessions/**/rollout-*.jsonl",
    };
  }
  if (agentId === "claude") {
    return {
      kind: "claude_projects",
      root: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"),
      pattern: "projects/**/*.jsonl",
    };
  }
  return { kind: "provider_session_id" };
}

function isHistoryInsertTraceEnabled(): boolean {
  return parseBooleanFlag(process.env.ADS_TRACE_HISTORY_INSERT, false);
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
  private selectByClientMessageKindStmt?: SqliteStatement;
  private updateKindByIdStmt?: SqliteStatement;
  private selectIdByExactKindStmt?: SqliteStatement;
  private updateTextAndTsByIdStmt?: SqliteStatement;
  private deleteSessionLinksStmt?: SqliteStatement;
  private upsertSessionLinkStmt?: SqliteStatement;
  private selectSessionLinksStmt?: SqliteStatement;

  constructor(options: HistoryStoreOptions = {}) {
    this.storagePath = options.storagePath ?? path.join(resolveAdsStateDir(), "state.db");
    this.namespace = options.namespace?.trim() || "default";
    this.maxEntriesPerSession = Math.max(1, options.maxEntriesPerSession ?? 200);
    this.maxTextLength = options.maxTextLength ?? 64 * 1024;
    this.useSqlite = isSqliteDbPath(this.storagePath);
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

  add(sessionId: string, entry: HistoryEntry): boolean {
    return this.addWithResult(sessionId, entry) === "inserted";
  }

  addWithResult(sessionId: string, entry: HistoryEntry): "inserted" | "duplicate" | "failed" {
    const normalized = this.normalize(entry);
    if (!normalized) return "failed";
    const normalizedKey = String(sessionId ?? "").trim();
    if (!normalizedKey) {
      return "failed";
    }

    if (!this.useSqlite || !this.db || !this.insertStmt) {
      const existing = this.store.get(normalizedKey) ?? [];
      if (sameHistoryClientMessageKind(normalized.kind, normalized.kind)) {
        const already = existing.some((e) => sameHistoryClientMessageKind(e.kind, normalized.kind));
        if (already) {
          return "duplicate";
        }
      }
      existing.push(normalized);
      const trimmed = this.trim(existing);
      this.store.set(normalizedKey, trimmed);
      this.persist();
      return "inserted";
    }

    const tx = this.db.transaction((): "inserted" | "duplicate" => {
      const info = this.insertStmt!.run(
        this.namespace,
        normalizedKey,
        normalized.role,
        normalized.text,
        normalized.ts,
        normalized.kind ?? null,
      );

      const changes = (info as { changes?: unknown }).changes;
      const inserted = typeof changes === "number" ? changes > 0 : true;

      if (isHistoryInsertTraceEnabled()) {
        const lastInsertRowid = (info as { lastInsertRowid?: unknown }).lastInsertRowid;
        const rowId =
          typeof lastInsertRowid === "bigint"
            ? lastInsertRowid.toString()
            : typeof lastInsertRowid === "number"
              ? String(lastInsertRowid)
              : "unknown";
        const action = inserted ? "insert" : "dedupe";
        logger.info(
          `[HistoryStore] ${action} ns=${this.namespace} session=${normalizedKey} id=${rowId} role=${normalized.role} kind=${normalized.kind ?? ""} ts=${normalized.ts} text=${truncateForLog(normalized.text, 160)}`,
        );
      }

      if (inserted) {
        this.trimSqlite(normalizedKey);
      }
      return inserted ? "inserted" : "duplicate";
    });
    try {
      return tx();
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to insert history entry (sqlite)`, error);
      return "failed";
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
      const tx = this.db.transaction(() => {
        this.deleteSessionStmt!.run(this.namespace, normalizedKey);
        this.deleteSessionLinksStmt?.run(this.namespace, normalizedKey);
      });
      tx();
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to clear history session (sqlite)`, error);
    }
  }

  linkAgentSession(
    sessionId: string,
    link: Pick<AgentSessionLink, "agentId" | "providerSessionId" | "cwd">,
  ): boolean {
    const normalizedSessionId = String(sessionId ?? "").trim();
    const agentId = String(link.agentId ?? "").trim();
    const providerSessionId = String(link.providerSessionId ?? "").trim();
    if (!normalizedSessionId || !agentId || !providerSessionId || !this.db || !this.upsertSessionLinkStmt) {
      return false;
    }
    const cwd = String(link.cwd ?? "").trim() || null;
    const locator = resolveAgentSessionLocator(agentId);
    const now = Date.now();
    try {
      this.upsertSessionLinkStmt.run(
        this.namespace,
        normalizedSessionId,
        agentId,
        providerSessionId,
        cwd,
        JSON.stringify(locator),
        now,
        now,
      );
      return true;
    } catch (error) {
      logger.warn("[HistoryStore] Failed to link agent session", error);
      return false;
    }
  }

  getAgentSessionLinks(sessionId: string): AgentSessionLink[] {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId || !this.db || !this.selectSessionLinksStmt) {
      return [];
    }
    const rows = this.selectSessionLinksStmt.all(this.namespace, normalizedSessionId) as Array<{
      agentId: string;
      providerSessionId: string;
      cwd: string | null;
      locatorJson: string | null;
      firstSeenAt: number;
      lastSeenAt: number;
    }>;
    return rows.map((row) => {
      let locator: AgentSessionLink["locator"];
      try {
        locator = row.locatorJson ? JSON.parse(row.locatorJson) as AgentSessionLink["locator"] : undefined;
      } catch {
        locator = undefined;
      }
      return {
        agentId: row.agentId,
        providerSessionId: row.providerSessionId,
        cwd: row.cwd ?? undefined,
        locator,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
      };
    });
  }

  updatePromptExecutionMetadata(
    sessionId: string,
    clientMessageId: string,
    metadata: PromptExecutionMetadata,
  ): boolean {
    const normalizedSessionId = String(sessionId ?? "").trim();
    const normalizedClientMessageId = String(clientMessageId ?? "").trim();
    if (!normalizedSessionId || !normalizedClientMessageId) {
      return false;
    }
    if (!this.useSqlite || !this.db || !this.selectByClientMessageKindStmt || !this.updateKindByIdStmt) {
      const existing = this.store.get(normalizedSessionId);
      if (!existing) return false;
      let updated = false;
      const next = existing.map((entry) => {
        if (getHistoryClientMessageId(entry.kind) !== normalizedClientMessageId) {
          return entry;
        }
        const mergedKind = mergePromptExecutionMetadataIntoKind({
          kind: entry.kind ?? "",
          metadata,
        });
        if (!mergedKind || mergedKind === entry.kind) {
          return entry;
        }
        updated = true;
        return { ...entry, kind: mergedKind };
      });
      if (!updated) return false;
      this.store.set(normalizedSessionId, next);
      this.persist();
      return true;
    }

    try {
      const row = this.selectByClientMessageKindStmt.get(
        this.namespace,
        normalizedSessionId,
        `client_message_id:${normalizedClientMessageId}`,
        `client_message_id:${normalizedClientMessageId};%`,
      ) as { id?: number; kind?: string | null } | undefined;
      if (!row || typeof row.id !== "number") return false;
      const mergedKind = mergePromptExecutionMetadataIntoKind({
        kind: row.kind ?? "",
        metadata,
      });
      if (!mergedKind || mergedKind === row.kind) return false;
      this.updateKindByIdStmt.run(mergedKind, row.id);
      return true;
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to update prompt execution metadata (sqlite)`, error);
      return false;
    }
  }

  upsertEntryByKind(sessionId: string, entry: HistoryEntry): "inserted" | "updated" | "skipped" {
    const normalized = this.normalize(entry);
    if (!normalized) return "skipped";
    const normalizedKey = String(sessionId ?? "").trim();
    if (!normalizedKey) return "skipped";
    const kindKey = String(normalized.kind ?? "").trim();
    if (!kindKey) return "skipped";

    if (!this.useSqlite || !this.db || !this.selectIdByExactKindStmt || !this.updateTextAndTsByIdStmt || !this.insertStmt) {
      const existing = this.store.get(normalizedKey) ?? [];
      const idx = existing.findIndex((e) => String(e.kind ?? "") === kindKey);
      if (idx >= 0) {
        const prev = existing[idx];
        if (prev && prev.text === normalized.text && prev.ts === normalized.ts) {
          return "skipped";
        }
        const next = existing.slice();
        next[idx] = { ...next[idx], text: normalized.text, ts: normalized.ts };
        this.store.set(normalizedKey, next);
        this.persist();
        return "updated";
      }
      existing.push(normalized);
      const trimmed = this.trim(existing);
      this.store.set(normalizedKey, trimmed);
      this.persist();
      return "inserted";
    }

    try {
      const row = this.selectIdByExactKindStmt.get(this.namespace, normalizedKey, kindKey) as
        | { id?: number; text?: string | null; ts?: number | null }
        | undefined;
      if (row && typeof row.id === "number") {
        if (row.text === normalized.text && row.ts === normalized.ts) {
          return "skipped";
        }
        this.updateTextAndTsByIdStmt.run(normalized.text, normalized.ts, row.id);
        return "updated";
      }
      this.insertStmt.run(
        this.namespace,
        normalizedKey,
        normalized.role,
        normalized.text,
        normalized.ts,
        normalized.kind ?? null,
      );
      this.trimSqlite(normalizedKey);
      return "inserted";
    } catch (error) {
      logger.warn(`[HistoryStore] Failed to upsert history entry by kind (sqlite)`, error);
      return "skipped";
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
    const statements = getHistoryStoreStatements(this.db);
    this.insertStmt = statements.insertStmt;
    this.selectStmt = statements.selectStmt;
    this.deleteSessionStmt = statements.deleteSessionStmt;
    this.cutoffStmt = statements.cutoffStmt;
    this.deleteOlderStmt = statements.deleteOlderStmt;
    this.getMigrationMarkerStmt = statements.getMigrationMarkerStmt;
    this.setMigrationMarkerStmt = statements.setMigrationMarkerStmt;
    this.selectByClientMessageKindStmt = statements.selectByClientMessageKindStmt;
    this.updateKindByIdStmt = statements.updateKindByIdStmt;
    this.selectIdByExactKindStmt = statements.selectIdByExactKindStmt;
    this.updateTextAndTsByIdStmt = statements.updateTextAndTsByIdStmt;
    this.deleteSessionLinksStmt = statements.deleteSessionLinksStmt;
    this.upsertSessionLinkStmt = statements.upsertSessionLinkStmt;
    this.selectSessionLinksStmt = statements.selectSessionLinksStmt;
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

function getHistoryStoreStatements(db: DatabaseType): HistoryStoreStatements {
  const cached = historyStoreStatementsCache.get(db);
  if (cached) {
    return cached;
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO history_entries (namespace, session_id, role, text, ts, kind)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectStmt = db.prepare(
    `SELECT role, text, ts, kind
     FROM history_entries
     WHERE namespace = ? AND session_id = ?
     ORDER BY id ASC`,
  );
  const deleteSessionStmt = db.prepare(
    `DELETE FROM history_entries WHERE namespace = ? AND session_id = ?`,
  );
  const cutoffStmt = db.prepare(
    `SELECT id FROM history_entries
     WHERE namespace = ? AND session_id = ?
     ORDER BY id DESC
     LIMIT 1 OFFSET ?`,
  );
  const deleteOlderStmt = db.prepare(
    `DELETE FROM history_entries WHERE namespace = ? AND session_id = ? AND id < ?`,
  );
  const selectByClientMessageKindStmt = db.prepare(
    `SELECT id, kind FROM history_entries
     WHERE namespace = ? AND session_id = ?
       AND (kind = ? OR kind LIKE ?)
     ORDER BY id DESC
     LIMIT 1`,
  );
  const updateKindByIdStmt = db.prepare(
    `UPDATE history_entries SET kind = ? WHERE id = ?`,
  );
  const selectIdByExactKindStmt = db.prepare(
    `SELECT id, text, ts FROM history_entries
     WHERE namespace = ? AND session_id = ? AND kind = ?
     ORDER BY id DESC
     LIMIT 1`,
  );
  const updateTextAndTsByIdStmt = db.prepare(
    `UPDATE history_entries SET text = ?, ts = ? WHERE id = ?`,
  );
  const deleteSessionLinksStmt = db.prepare(
    `DELETE FROM history_session_links WHERE namespace = ? AND session_id = ?`,
  );
  const upsertSessionLinkStmt = db.prepare(
    `INSERT INTO history_session_links
       (namespace, session_id, agent_id, provider_session_id, cwd, locator_json, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, session_id, agent_id, provider_session_id)
     DO UPDATE SET
       cwd = COALESCE(excluded.cwd, history_session_links.cwd),
       locator_json = excluded.locator_json,
       last_seen_at = excluded.last_seen_at`,
  );
  const selectSessionLinksStmt = db.prepare(
    `SELECT
       agent_id AS agentId,
       provider_session_id AS providerSessionId,
       cwd,
       locator_json AS locatorJson,
       first_seen_at AS firstSeenAt,
       last_seen_at AS lastSeenAt
     FROM history_session_links
     WHERE namespace = ? AND session_id = ?
     ORDER BY last_seen_at DESC`,
  );
  const { getMigrationMarkerStmt, setMigrationMarkerStmt } = prepareMigrationMarkerStatements(db);
  const statements = {
    insertStmt,
    selectStmt,
    deleteSessionStmt,
    cutoffStmt,
    deleteOlderStmt,
    getMigrationMarkerStmt,
    setMigrationMarkerStmt,
    selectByClientMessageKindStmt,
    updateKindByIdStmt,
    selectIdByExactKindStmt,
    updateTextAndTsByIdStmt,
    deleteSessionLinksStmt,
    upsertSessionLinkStmt,
    selectSessionLinksStmt,
  };
  historyStoreStatementsCache.set(db, statements);
  return statements;
}

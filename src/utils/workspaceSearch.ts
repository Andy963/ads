import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { createLogger } from "./logger.js";
import { stripLeadingTranslation } from "./assistantText.js";
import { loadWorkspaceHistoryRows, type WorkspaceHistoryRow } from "./workspaceHistory.js";
import type { WorkspaceHistorySearchEngine } from "./workspaceHistoryConfig.js";

type SqliteStatement = StatementType<unknown[], unknown>;

const logger = createLogger("WorkspaceSearch");

export interface WorkspaceSearchParams {
  workspaceRoot: string;
  query: string;
  engine: WorkspaceHistorySearchEngine;
  scanLimit: number;
  maxResults: number;
  maxChars: number;
}

export interface WorkspaceSearchOutcome {
  output: string;
  engineUsed: WorkspaceHistorySearchEngine;
  degraded: boolean;
}

function truncateToChars(text: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return "…";
  }
  return `${text.slice(0, limit - 1)}…`;
}

function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  try {
    return new Date(ts).toISOString().replace("T", " ").replace("Z", "");
  } catch {
    return "";
  }
}

function normalizeQueryToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}_]+/gu, "");
}

function escapeFtsToken(token: string): string {
  return token.replace(/"/g, '""');
}

function buildFtsQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return "";
  }
  const tokens = trimmed
    .split(/\s+/)
    .map((part) => normalizeQueryToken(part))
    .filter(Boolean)
    .slice(0, 8);

  if (tokens.length === 0) {
    return `"${escapeFtsToken(trimmed)}"`;
  }

  if (tokens.length === 1) {
    return `"${escapeFtsToken(tokens[0])}"`;
  }
  return tokens.map((token) => `"${escapeFtsToken(token)}"`).join(" AND ");
}

function resolveInitializedWorkspaceDbPath(workspaceRoot: string): string | null {
  const resolvedRoot = path.resolve(String(workspaceRoot ?? "").trim());
  if (!resolvedRoot) {
    return null;
  }
  const marker = path.join(resolvedRoot, ".ads", "workspace.json");
  if (!fs.existsSync(marker)) {
    return null;
  }
  const adsDir = path.join(resolvedRoot, ".ads");
  if (!fs.existsSync(adsDir)) {
    return null;
  }
  return path.join(adsDir, "state.db");
}

function ensureFtsSchema(db: DatabaseType): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS history_entries_fts
    USING fts5(text, tokenize = 'unicode61');

    CREATE TRIGGER IF NOT EXISTS history_entries_fts_ai
    AFTER INSERT ON history_entries
    BEGIN
      INSERT INTO history_entries_fts(rowid, text)
      SELECT new.id, new.text
      WHERE new.role IN ('user','ai');
    END;

    CREATE TRIGGER IF NOT EXISTS history_entries_fts_ad
    AFTER DELETE ON history_entries
    BEGIN
      INSERT INTO history_entries_fts(history_entries_fts, rowid, text)
      SELECT 'delete', old.id, old.text
      WHERE old.role IN ('user','ai');
    END;

    CREATE TRIGGER IF NOT EXISTS history_entries_fts_au
    AFTER UPDATE ON history_entries
    BEGIN
      INSERT INTO history_entries_fts(history_entries_fts, rowid, text)
      SELECT 'delete', old.id, old.text
      WHERE old.role IN ('user','ai');

      INSERT INTO history_entries_fts(rowid, text)
      SELECT new.id, new.text
      WHERE new.role IN ('user','ai');
    END;
  `);
}

function hasMigrationMarker(db: DatabaseType, key: string): boolean {
  try {
    const row = db
      .prepare(`SELECT value FROM kv_state WHERE namespace = 'migrations' AND key = ?`)
      .get(key) as { value?: string } | undefined;
    return Boolean(row?.value);
  } catch {
    return false;
  }
}

function setMigrationMarker(db: DatabaseType, key: string): void {
  try {
    db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES ('migrations', ?, '1', ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, Date.now());
  } catch {
    // ignore marker write failures
  }
}

function backfillFtsIndex(db: DatabaseType): void {
  const tx = db.transaction(() => {
    db.exec(`INSERT INTO history_entries_fts(history_entries_fts) VALUES('delete-all');`);
    db.prepare(
      `INSERT INTO history_entries_fts(rowid, text)
       SELECT id, text
       FROM history_entries
       WHERE role IN ('user','ai')
       ORDER BY id ASC`,
    ).run();
  });
  tx();
}

function formatRowSnippet(row: WorkspaceHistoryRow, query: string): string {
  const roleLabel = row.role === "user" ? "U" : "A";
  const tsPart = formatTimestamp(row.ts);
  const prefixParts = [`[${row.namespace}]`, tsPart ? tsPart : null, roleLabel].filter(Boolean);
  const prefix = prefixParts.join(" ");
  const text = stripLeadingTranslation(row.text).replace(/\s+/g, " ").trim();
  const maxSnippet = 180;

  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx <= 0) {
    return `${prefix}: ${truncateToChars(text, maxSnippet)}`;
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + Math.max(40, query.length) + 60);
  const slice = text.slice(start, end);
  const decorated = `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
  return `${prefix}: ${truncateToChars(decorated, maxSnippet)}`;
}

function formatSearchOutput(
  query: string,
  engineUsed: WorkspaceHistorySearchEngine,
  degraded: boolean,
  rows: WorkspaceHistoryRow[],
  maxChars: number,
): string {
  const header = `🔎 /search "${truncateToChars(query.trim(), 64)}" (engine: ${engineUsed}${degraded ? ", degraded" : ""})`;
  if (rows.length === 0) {
    return truncateToChars(`${header}\n(0 results)`, maxChars);
  }

  const lines: string[] = [header];
  for (let i = 0; i < rows.length; i += 1) {
    const line = `${i + 1}. ${formatRowSnippet(rows[i], query)}`;
    lines.push(line);
  }
  return truncateToChars(lines.join("\n"), maxChars);
}

function tryFtsSearch(db: DatabaseType, params: WorkspaceSearchParams): WorkspaceHistoryRow[] {
  const preparedQuery = buildFtsQuery(params.query);
  if (!preparedQuery) {
    return [];
  }


  const queryTokens = params.query
    .trim()
    .split(/\s+/)
    .map((part) => normalizeQueryToken(part))
    .filter(Boolean)
    .slice(0, 8);
  const normalizedRawQuery = params.query.trim().toLowerCase();
  const normalizedQueryTokens = queryTokens.map((token) => token.toLowerCase());

  let stmt: SqliteStatement;
  const rawLimit = Math.min(Math.max(params.maxResults * 4, params.maxResults), 80);
  try {
    stmt = db.prepare(
      `SELECT h.id, h.namespace, h.session_id, h.role, h.text, h.ts, h.kind
       FROM history_entries_fts
       JOIN history_entries h ON h.id = history_entries_fts.rowid
       WHERE history_entries_fts MATCH ?
         AND h.role IN ('user','ai')
       ORDER BY bm25(history_entries_fts), h.id DESC
       LIMIT ?`,
    );
  } catch (error) {
    logger.warn("[WorkspaceSearch] Failed to prepare FTS query", error);
    return [];
  }

  try {
    const rows = stmt.all(preparedQuery, rawLimit) as Array<{
      id: number;
      namespace: string;
      session_id: string;
      role: string;
      text: string;
      ts: number;
      kind: string | null;
    }>;
    const hits: WorkspaceHistoryRow[] = [];
    for (const row of rows) {
      if (hits.length >= params.maxResults) {
        break;
      }
      const cleanedText = stripLeadingTranslation(row.text);
      const normalizedCleaned = cleanedText.toLowerCase();
      const matchesQuery =
        normalizedQueryTokens.length === 0
          ? normalizedRawQuery === "" || normalizedCleaned.includes(normalizedRawQuery)
          : normalizedQueryTokens.every((token) => normalizedCleaned.includes(token));
      if (!matchesQuery) {
        continue;
      }
      hits.push({
        id: row.id,
        namespace: row.namespace,
        session_id: row.session_id,
        role: row.role,
        text: row.text,
        ts: row.ts,
        kind: row.kind ?? undefined,
      });
    }
    return hits;
  } catch (error) {
    logger.warn("[WorkspaceSearch] FTS query failed", error);
    return [];
  }
}

function windowScanSearch(params: WorkspaceSearchParams): WorkspaceHistoryRow[] {
  const query = params.query.trim();
  if (!query) {
    return [];
  }
  const rows = loadWorkspaceHistoryRows({
    workspaceRoot: params.workspaceRoot,
    roles: ["user", "ai"],
    limit: params.scanLimit,
  });

  const normalizedQuery = query.toLowerCase();
  const hits: WorkspaceHistoryRow[] = [];
  for (const row of rows) {
    if (hits.length >= params.maxResults) {
      break;
    }
    if (stripLeadingTranslation(row.text).toLowerCase().includes(normalizedQuery)) {
      hits.push(row);
    }
  }
  return hits;
}

export function searchWorkspaceHistory(params: WorkspaceSearchParams): WorkspaceSearchOutcome {
  const trimmed = params.query.trim();
  if (!trimmed) {
    return {
      output: truncateToChars("用法: /search <query>", params.maxChars),
      engineUsed: params.engine,
      degraded: false,
    };
  }

  if (params.engine === "window-scan") {
    const hits = windowScanSearch(params);
    return {
      output: formatSearchOutput(trimmed, "window-scan", false, hits, params.maxChars),
      engineUsed: "window-scan",
      degraded: false,
    };
  }

  const dbPath = resolveInitializedWorkspaceDbPath(params.workspaceRoot);
  if (!dbPath) {
    return {
      output: truncateToChars(`⚠️ 工作空间未初始化，无法搜索历史: ${path.resolve(params.workspaceRoot)}`, params.maxChars),
      engineUsed: "window-scan",
      degraded: true,
    };
  }
  let db: DatabaseType;
  try {
    db = getStateDatabase(dbPath);
  } catch (error) {
    logger.warn(`[WorkspaceSearch] Failed to open state db at ${dbPath}`, error);
    const hits = windowScanSearch({ ...params, engine: "window-scan" });
    return {
      output: formatSearchOutput(trimmed, "window-scan", true, hits, params.maxChars),
      engineUsed: "window-scan",
      degraded: true,
    };
  }

  try {
    ensureFtsSchema(db);
    const markerKey = "history_entries_fts_v1";
    if (!hasMigrationMarker(db, markerKey)) {
      backfillFtsIndex(db);
      setMigrationMarker(db, markerKey);
    }
    const hits = tryFtsSearch(db, params);
    return {
      output: formatSearchOutput(trimmed, "fts5", false, hits, params.maxChars),
      engineUsed: "fts5",
      degraded: false,
    };
  } catch (error) {
    logger.warn("[WorkspaceSearch] FTS path failed, falling back", error);
    const hits = windowScanSearch({ ...params, engine: "window-scan" });
    return {
      output: formatSearchOutput(trimmed, "window-scan", true, hits, params.maxChars),
      engineUsed: "window-scan",
      degraded: true,
    };
  }
}

import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";

type SqliteStatement = StatementType<unknown[], unknown>;

const KV_NAMESPACE = "vector_search";

export function resolveWorkspaceStateDbPath(workspaceRoot: string): string | null {
  const resolvedRoot = path.resolve(String(workspaceRoot ?? "").trim());
  if (!resolvedRoot) return null;
  migrateLegacyWorkspaceAdsIfNeeded(resolvedRoot);
  if (!fs.existsSync(resolveWorkspaceStatePath(resolvedRoot, "workspace.json"))) return null;
  return resolveWorkspaceStatePath(resolvedRoot, "state.db");
}

function withWorkspaceDb<T>(workspaceRoot: string, fn: (db: DatabaseType) => T): T | undefined {
  const dbPath = resolveWorkspaceStateDbPath(workspaceRoot);
  if (!dbPath) return undefined;
  const db = getStateDatabase(dbPath);
  return fn(db);
}

export function getVectorState(workspaceRoot: string, key: string): string | undefined {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) return undefined;
  return withWorkspaceDb(workspaceRoot, (db) => {
    const stmt: SqliteStatement = db.prepare(`SELECT value FROM kv_state WHERE namespace = ? AND key = ?`);
    const row = stmt.get(KV_NAMESPACE, normalizedKey) as { value?: string } | undefined;
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    return value || undefined;
  });
}

export function setVectorState(workspaceRoot: string, key: string, value: string): void {
  const normalizedKey = String(key ?? "").trim();
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedKey || !normalizedValue) return;
  withWorkspaceDb(workspaceRoot, (db) => {
    const stmt: SqliteStatement = db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    stmt.run(KV_NAMESPACE, normalizedKey, normalizedValue, Date.now());
  });
}

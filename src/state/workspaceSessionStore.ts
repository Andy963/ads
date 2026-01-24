import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "./database.js";

type SqliteStatement = StatementType<unknown[], unknown>;

const NAMESPACE = "workspace_session";
const ACTIVE_THREAD_KEY = "active_thread_id";

function resolveWorkspaceStateDbPath(workspaceRoot: string): string | null {
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

function withWorkspaceDb<T>(workspaceRoot: string, fn: (db: DatabaseType) => T): T | undefined {
  const dbPath = resolveWorkspaceStateDbPath(workspaceRoot);
  if (!dbPath) {
    return undefined;
  }
  const db = getStateDatabase(dbPath);
  return fn(db);
}

export function getActiveThreadId(workspaceRoot: string): string | undefined {
  return withWorkspaceDb(workspaceRoot, (db) => {
    const stmt: SqliteStatement = db.prepare(
      `SELECT value FROM kv_state WHERE namespace = ? AND key = ?`,
    );
    const row = stmt.get(NAMESPACE, ACTIVE_THREAD_KEY) as { value?: string } | undefined;
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    return value || undefined;
  });
}

export function setActiveThreadId(workspaceRoot: string, threadId: string): void {
  const normalized = String(threadId ?? "").trim();
  if (!normalized) {
    return;
  }
  withWorkspaceDb(workspaceRoot, (db) => {
    const stmt: SqliteStatement = db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    stmt.run(NAMESPACE, ACTIVE_THREAD_KEY, normalized, Date.now());
  });
}

export function clearActiveThreadId(workspaceRoot: string): void {
  withWorkspaceDb(workspaceRoot, (db) => {
    const stmt: SqliteStatement = db.prepare(
      `DELETE FROM kv_state WHERE namespace = ? AND key = ?`,
    );
    stmt.run(NAMESPACE, ACTIVE_THREAD_KEY);
  });
}


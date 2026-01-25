import fs from "node:fs";
import path from "node:path";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createLogger } from "../utils/logger.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";

const logger = createLogger("StateDatabase");

let cachedDbs = new Map<string, DatabaseType>();

export function resolveStateDbPath(explicitPath?: string): string {
  const envPath = process.env.ADS_STATE_DB_PATH;
  const candidate = explicitPath ?? envPath;
  if (candidate) {
    if (candidate === ":memory:") {
      return candidate;
    }
    return path.resolve(candidate);
  }
  return path.join(resolveAdsStateDir(), "state.db");
}

function ensureParentDir(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function initializeStateDatabase(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_state (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)
    );

    CREATE TABLE IF NOT EXISTS thread_state (
      namespace TEXT NOT NULL,
      user_hash TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      cwd TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, user_hash)
    );

    CREATE TABLE IF NOT EXISTS history_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_history_entries_session
      ON history_entries(namespace, session_id, id);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT NOT NULL PRIMARY KEY,
      parent_task_id TEXT,
      namespace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      result_json TEXT,
      verification_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_active
      ON tasks(namespace, session_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS task_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT,
      payload TEXT,
      ts INTEGER NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_messages_task
      ON task_messages(namespace, session_id, task_id, id);
  `);
}

export function getStateDatabase(explicitPath?: string): DatabaseType {
  const dbPath = resolveStateDbPath(explicitPath);
  const existing = cachedDbs.get(dbPath);
  if (existing) {
    return existing;
  }

  ensureParentDir(dbPath);
  const db = new DatabaseConstructor(dbPath, { readonly: false, fileMustExist: false });
  initializeStateDatabase(db);
  cachedDbs.set(dbPath, db);
  return db;
}

export function resetStateDatabaseForTests(): void {
  for (const db of cachedDbs.values()) {
    try {
      db.close();
    } catch (error) {
      logger.warn("[StateDatabase] Failed to close db during reset", error);
    }
  }
  cachedDbs = new Map();
}

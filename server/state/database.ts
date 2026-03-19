import fs from "node:fs";
import path from "node:path";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { stateSchemaMigrations } from "./schemaMigrations.js";
import { createLogger } from "../utils/logger.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";

const logger = createLogger("StateDatabase");
const LEGACY_STATE_SCHEMA_VERSION = 1;
const LEGACY_STATE_TABLES = [
  "kv_state",
  "thread_state",
  "history_entries",
  "tasks",
  "task_messages",
  "web_task_bundle_drafts",
] as const;

let cachedDbs = new Map<string, DatabaseType>();

export const STATE_SCHEMA_VERSION = stateSchemaMigrations.length;

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

function hasLegacyStateTables(db: DatabaseType): boolean {
  const placeholders = LEGACY_STATE_TABLES.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${placeholders})
       LIMIT 1`,
    )
    .get(...LEGACY_STATE_TABLES);
  return Boolean(row);
}

function getStateSchemaVersion(db: DatabaseType): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
    | { version: number }
    | undefined;

  if (!row) {
    const version = hasLegacyStateTables(db) ? LEGACY_STATE_SCHEMA_VERSION : 0;
    db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(version);
    return version;
  }

  return row.version;
}

function setStateSchemaVersion(db: DatabaseType, version: number): void {
  db.prepare("UPDATE schema_version SET version = ?, updated_at = datetime('now') WHERE id = 1").run(version);
}

function runStateMigrations(db: DatabaseType): void {
  const currentVersion = getStateSchemaVersion(db);
  const targetVersion = stateSchemaMigrations.length;

  if (currentVersion >= targetVersion) {
    return;
  }

  for (let i = currentVersion; i < targetVersion; i++) {
    const migration = stateSchemaMigrations[i];
    const tx = db.transaction(() => {
      migration.up(db);
      setStateSchemaVersion(db, migration.version);
    });
    try {
      tx();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`State migration ${migration.version} (${migration.description}) failed: ${message}`);
    }
  }
}

function initializeStateDatabase(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runStateMigrations(db);
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

export function getStateDatabaseInfo(explicitPath?: string): {
  path: string;
  schemaVersion: number;
  latestVersion: number;
  needsMigration: boolean;
} {
  const db = getStateDatabase(explicitPath);
  const dbPath = resolveStateDbPath(explicitPath);
  const schemaVersion = getStateSchemaVersion(db);

  return {
    path: dbPath,
    schemaVersion,
    latestVersion: STATE_SCHEMA_VERSION,
    needsMigration: schemaVersion < STATE_SCHEMA_VERSION,
  };
}

export function closeAllStateDatabases(): void {
  for (const db of cachedDbs.values()) {
    try {
      db.close();
    } catch (error) {
      logger.warn("[StateDatabase] Failed to close db", error);
    }
  }
  cachedDbs = new Map();
}

export function resetStateDatabaseForTests(): void {
  closeAllStateDatabases();
}

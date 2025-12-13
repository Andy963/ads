import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { detectWorkspace, getWorkspaceDbPath } from "../workspace/detector.js";
import { migrations } from "./migrations.js";

let cachedDbs: Map<string, DatabaseType> = new Map();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** 当前 schema 版本（等于 migrations 数组长度） */
export const SCHEMA_VERSION = migrations.length;

function readPackageName(): string | null {
  const pkgPath = path.join(PROJECT_ROOT, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(content) as { name?: string };
    return parsed?.name ?? null;
  } catch {
    return null;
  }
}

function resolveDatabasePath(workspacePath?: string): string {
  const envDb = process.env.ADS_DATABASE_PATH || process.env.DATABASE_URL;
  if (envDb) {
    return envDb.replace(/^sqlite:\/\//, "");
  }

  // If explicit workspace path provided, use it
  if (workspacePath) {
    return getWorkspaceDbPath(path.resolve(workspacePath));
  }

  // If AD_WORKSPACE env is set, use that workspace's database
  const envWorkspace = process.env.AD_WORKSPACE;
  if (envWorkspace) {
    return getWorkspaceDbPath(path.resolve(envWorkspace));
  }

  // For ADS project itself (development), use project root database
  const projectName = readPackageName();
  if (projectName === "ads") {
    return path.join(PROJECT_ROOT, "ads.db");
  }

  try {
    const workspaceRoot = detectWorkspace();
    return getWorkspaceDbPath(workspaceRoot);
  } catch {
    return path.join(process.cwd(), "ads.db");
  }
}

/**
 * 获取当前数据库 schema 版本
 */
function getSchemaVersion(db: DatabaseType): number {
  // 创建 schema_version 表（如果不存在）
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
    // 检查是否是已有数据库（有 nodes 表但没有版本记录）
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (tables) {
      // 已有数据库，假设是版本 1
      db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 1)").run();
      return 1;
    }
    // 新数据库，版本为 0
    db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 0)").run();
    return 0;
  }

  return row.version;
}

/**
 * 更新 schema 版本号
 */
function setSchemaVersion(db: DatabaseType, version: number): void {
  db.prepare("UPDATE schema_version SET version = ?, updated_at = datetime('now') WHERE id = 1").run(version);
}

/**
 * 运行数据库迁移
 */
function runMigrations(db: DatabaseType): void {
  const currentVersion = getSchemaVersion(db);
  const targetVersion = migrations.length;

  if (currentVersion >= targetVersion) {
    return; // 已是最新版本
  }

  // 按顺序执行未运行的迁移
  for (let i = currentVersion; i < targetVersion; i++) {
    const migration = migrations[i];
    try {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    } catch (error) {
      throw new Error(
        `Migration ${migration.version} (${migration.description}) failed: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * 初始化数据库（运行迁移）
 */
function initializeDatabase(db: DatabaseType): void {
  runMigrations(db);
}

export function getDatabase(workspacePath?: string): DatabaseType {
  const dbPath = resolveDatabasePath(workspacePath);
  const existing = cachedDbs.get(dbPath);
  if (existing) {
    return existing;
  }

  const db = new DatabaseConstructor(dbPath, { readonly: false, fileMustExist: false });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  initializeDatabase(db);
  cachedDbs.set(dbPath, db);
  return db;
}

export function resetDatabaseForTests(): void {
  for (const db of cachedDbs.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  cachedDbs = new Map();
}

/**
 * 获取数据库版本信息
 */
export function getDatabaseInfo(workspacePath?: string): {
  path: string;
  schemaVersion: number;
  latestVersion: number;
  needsMigration: boolean;
} {
  const db = getDatabase(workspacePath);
  const dbPath = resolveDatabasePath(workspacePath);
  const schemaVersion = getSchemaVersion(db);

  return {
    path: dbPath,
    schemaVersion,
    latestVersion: SCHEMA_VERSION,
    needsMigration: schemaVersion < SCHEMA_VERSION,
  };
}

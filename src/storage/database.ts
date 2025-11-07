import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";
import toml from "toml";

import { detectWorkspace, getWorkspaceDbPath } from "../workspace/detector.js";

let cachedDb: DatabaseType | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function readPyProjectName(): string | null {
  const pyprojectPath = path.join(PROJECT_ROOT, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(pyprojectPath, "utf-8");
    const parsed = toml.parse(content);
    return parsed?.project?.name ?? null;
  } catch {
    return null;
  }
}

function resolveDatabasePath(): string {
  const envDb = process.env.ADS_DATABASE_PATH || process.env.DATABASE_URL;
  if (envDb) {
    return envDb.replace(/^sqlite:\/\//, "");
  }

  const projectName = readPyProjectName();
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

function initializeDatabase(db: DatabaseType): void {
  // Create nodes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      content TEXT,
      metadata TEXT,
      position TEXT,
      current_version INTEGER DEFAULT 0,
      draft_content TEXT,
      draft_source_type TEXT,
      draft_conversation_id TEXT,
      draft_message_id INTEGER,
      draft_based_on_version INTEGER,
      draft_ai_original_content TEXT,
      is_draft INTEGER DEFAULT 1,
      draft_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      workspace_id INTEGER
    )
  `);

  // Create node_versions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      conversation_id TEXT,
      message_id INTEGER,
      based_on_version INTEGER,
      change_description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )
  `);

  // Create indexes for node_versions
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_node_versions_node_id ON node_versions(node_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_node_versions_version ON node_versions(node_id, version)
  `);

  // Create edges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      source_handle TEXT DEFAULT 'right',
      target_handle TEXT DEFAULT 'left',
      label TEXT,
      edge_type TEXT DEFAULT 'next',
      animated INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Create workflow commits table
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      workflow_title TEXT,
      template TEXT,
      node_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      node_label TEXT,
      version INTEGER NOT NULL,
      change_description TEXT,
      file_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_workflow_commits_workflow_id_created_at
      ON workflow_commits(workflow_id, created_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_workflow_commits_created_at
      ON workflow_commits(created_at DESC)
  `);
}

export function getDatabase(): DatabaseType {
  if (!cachedDb) {
    const dbPath = resolveDatabasePath();
    cachedDb = new DatabaseConstructor(dbPath, { readonly: false, fileMustExist: false });
    cachedDb.pragma("journal_mode = WAL");
    cachedDb.pragma("foreign_keys = ON");

    // Initialize database tables if they don't exist
    initializeDatabase(cachedDb);
  }
  return cachedDb;
}

export function resetDatabaseForTests(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}

import type { Database as DatabaseType } from "better-sqlite3";

export function ensureWebProjectTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_projects (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      display_name TEXT NOT NULL,
      chat_session_id TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, project_id),
      UNIQUE(user_id, workspace_root),
      FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_web_projects_user_updated
      ON web_projects(user_id, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS web_user_settings (
      user_id TEXT NOT NULL PRIMARY KEY,
      active_project_id TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
    );
  `);
}


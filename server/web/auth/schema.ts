import type { Database as DatabaseType } from "better-sqlite3";

export function ensureWebAuthTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER,
      disabled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_seen_at INTEGER,
      last_seen_ip TEXT,
      user_agent TEXT,
      FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
    );
  `);
}


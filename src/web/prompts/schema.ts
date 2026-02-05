import type { Database as DatabaseType } from "better-sqlite3";

export function ensureWebPromptTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_prompts (
      user_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, prompt_id),
      UNIQUE(user_id, name),
      FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_web_prompts_user_updated
      ON web_prompts(user_id, updated_at DESC, created_at DESC, prompt_id ASC);
  `);
}


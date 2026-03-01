import type { Database as DatabaseType } from "better-sqlite3";

export function ensureTaskNotificationTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_notifications (
      task_id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      task_title TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL,

      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,

      created_at INTEGER NOT NULL,
      notified_at INTEGER,
      last_error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_task_notifications_notified
      ON task_notifications(notified_at);

    CREATE INDEX IF NOT EXISTS idx_task_notifications_retry
      ON task_notifications(next_retry_at);

    CREATE INDEX IF NOT EXISTS idx_task_notifications_due
      ON task_notifications(notified_at, completed_at, next_retry_at, retry_count);
  `);

  const columns = db.prepare(`PRAGMA table_info('task_notifications')`).all() as Array<{ name?: unknown }>;
  const hasTaskTitle = columns.some((col) => String(col.name ?? "").trim() === "task_title");
  if (!hasTaskTitle) {
    try {
      db.exec(`ALTER TABLE task_notifications ADD COLUMN task_title TEXT NOT NULL DEFAULT ''`);
    } catch {
      // ignore
    }
  }
}


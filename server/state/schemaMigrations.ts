import type { Database as DatabaseType } from "better-sqlite3";

export interface StateSchemaMigration {
  version: number;
  description: string;
  up: (db: DatabaseType) => void;
}

export const stateSchemaMigrations: StateSchemaMigration[] = [
  {
    version: 1,
    description: "Baseline state schema for kv/thread/history/task/draft storage",
    up: (db) => {
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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_history_entries_client_message_id
          ON history_entries(namespace, session_id, kind)
          WHERE kind LIKE 'client_message_id:%';

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

        CREATE TABLE IF NOT EXISTS web_task_bundle_drafts (
          draft_id TEXT NOT NULL PRIMARY KEY,
          namespace TEXT NOT NULL,
          auth_user_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          request_id TEXT,
          source_chat_session_id TEXT NOT NULL,
          source_history_key TEXT,
          bundle_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          approved_at INTEGER,
          approved_task_ids_json TEXT,
          last_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_web_task_bundle_drafts_active
          ON web_task_bundle_drafts(namespace, auth_user_id, workspace_root, status, updated_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_web_task_bundle_drafts_request
          ON web_task_bundle_drafts(namespace, auth_user_id, workspace_root, request_id)
          WHERE request_id IS NOT NULL AND request_id != '';
      `);
    },
  },
];

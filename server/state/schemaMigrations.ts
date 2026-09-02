import { randomUUID } from "node:crypto";

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
          ON history_entries(
            namespace,
            session_id,
            substr(kind, length('client_message_id:') + 1, instr(kind || ';', ';') - length('client_message_id:') - 1)
          )
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
  {
    version: 2,
    description: "Hermes architecture - compaction snapshots and tool metrics",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS compaction_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('soft','hard','manual')),
          tokens_before INTEGER,
          tokens_after INTEGER,
          content TEXT NOT NULL,
          truncated TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_compaction_ws_ts
          ON compaction_snapshots(workspace_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS tool_call_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    description: "Model configs - reissue opaque ids for legacy rows whose id was the agent model id",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_configs (
          id TEXT PRIMARY KEY,
          model_id TEXT,
          display_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          is_default INTEGER NOT NULL DEFAULT 0,
          config_json TEXT,
          updated_at INTEGER
        )
      `);
      const columns = db
        .prepare("PRAGMA table_info(model_configs)")
        .all() as Array<{ name?: string }>;
      if (!columns.some((column) => column.name === "model_id")) {
        db.exec("ALTER TABLE model_configs ADD COLUMN model_id TEXT");
      }
      db.exec(`
        UPDATE model_configs
        SET model_id = id
        WHERE model_id IS NULL OR TRIM(model_id) = ''
      `);
      const legacyRows = db
        .prepare("SELECT id FROM model_configs WHERE id NOT LIKE 'model-%'")
        .all() as Array<{ id: string }>;
      const updateIdStmt = db.prepare("UPDATE model_configs SET id = ? WHERE id = ?");
      for (const row of legacyRows) {
        updateIdStmt.run(`model-${randomUUID()}`, row.id);
      }
    },
  },
  {
    version: 4,
    description: "History entries - dedupe client messages by id while preserving metadata in kind",
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_history_entries_client_message_id;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_history_entries_client_message_id
          ON history_entries(
            namespace,
            session_id,
            substr(kind, length('client_message_id:') + 1, instr(kind || ';', ';') - length('client_message_id:') - 1)
          )
          WHERE kind LIKE 'client_message_id:%';
      `);
    },
  },
  {
    version: 5,
    description: "Seed Codex and Claude model configs",
    up: (db) => {
      const insert = db.prepare(`
        INSERT INTO model_configs
          (id, model_id, display_name, provider, is_enabled, is_default, config_json, updated_at)
        SELECT ?, ?, ?, ?, 1, 0, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM model_configs WHERE model_id = ?)
      `);
      const now = Date.now();
      const models = [
        ["model-seed-codex-gpt-5-5", "gpt-5.5", "GPT-5.5", "openai", ["codex"]],
        ["model-seed-codex-gpt-5-6", "gpt-5.6", "GPT-5.6", "openai", ["codex"]],
        ["model-seed-claude-opus-4-8", "claude-opus-4.8", "Claude Opus 4.8", "anthropic", ["claude"]],
        ["model-seed-claude-fable-5", "claude-fable-5", "Claude Fable 5", "anthropic", ["claude"]],
      ] as const;
      for (const [id, modelId, displayName, provider, allowedAgents] of models) {
        insert.run(
          id,
          modelId,
          displayName,
          provider,
          JSON.stringify({ allowedAgents, reasoningEfforts: ["high", "xhigh", "max"], defaultReasoningEffort: "high" }),
          now,
          modelId,
        );
      }
    },
  },
  {
    version: 6,
    description: "Associate ADS history sessions with provider-local agent sessions",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS history_session_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          provider_session_id TEXT NOT NULL,
          cwd TEXT,
          locator_json TEXT,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          UNIQUE(namespace, session_id, agent_id, provider_session_id)
        );

        CREATE INDEX IF NOT EXISTS idx_history_session_links_lookup
          ON history_session_links(namespace, session_id, agent_id, last_seen_at DESC);
      `);
    },
  },
  {
    version: 7,
    description: "Durable web sync event log for reconnect catch-up",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL,
          lane_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_id TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          payload TEXT NOT NULL,
          ts INTEGER NOT NULL,
          run_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sync_events_lane
          ON sync_events(namespace, lane_key, seq);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_dedup
          ON sync_events(namespace, lane_key, event_type, event_id, revision)
          WHERE event_id IS NOT NULL;
      `);
    },
  },
  {
    version: 8,
    description: "Track trimmed web sync cursors per lane",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_lane_state (
          namespace TEXT NOT NULL,
          lane_key TEXT NOT NULL,
          trimmed_through_seq INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(namespace, lane_key)
        );
      `);
    },
  },
  {
    version: 9,
    description: "Global rules with audit log as the single source of truth for cross-channel rules",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS global_rules (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 100,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_by TEXT,
          match_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_global_rules_enabled
          ON global_rules(enabled, priority, created_at);

        CREATE TABLE IF NOT EXISTS global_rule_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id TEXT NOT NULL,
          action TEXT NOT NULL,
          before_json TEXT,
          after_json TEXT,
          actor TEXT,
          ts INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_global_rule_audit_rule
          ON global_rule_audit_log(rule_id, ts DESC);

        CREATE INDEX IF NOT EXISTS idx_global_rule_audit_ts
          ON global_rule_audit_log(ts DESC);
      `);
    },
  },
  {
    version: 10,
    description: "Reserved legacy migration; obsolete secondary CLI model seeding removed",
    up: () => {},
  },
  {
    version: 11,
    description: "Persist the explicitly selected reviewer model",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reviewer_model_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          model_config_id TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
];

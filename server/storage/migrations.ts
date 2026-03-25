/**
 * 数据库迁移管理
 * 
 * 每个迁移是一个函数，接收数据库实例并执行 schema 变更。
 * 迁移按顺序执行，版本号从 1 开始递增。
 * 
 * 添加新迁移时：
 * 1. 在 migrations 数组末尾添加新的迁移函数
 * 2. 迁移函数应该是幂等的（可以安全地多次运行）
 * 3. 使用 IF NOT EXISTS / IF EXISTS 等条件语句
 */

import type { Database as DatabaseType } from "better-sqlite3";

export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseType) => void;
}

function getTableColumnNames(db: DatabaseType, table: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(columns.map((c) => String(c.name ?? "").trim()).filter(Boolean));
}

/**
 * 迁移列表 - 按版本号顺序排列
 * 新迁移添加到数组末尾
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema - nodes, edges, node_versions, workflow_commits",
    up: (db) => {
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
    },
  },
  {
    version: 2,
    description: "Task queue system - tasks, task_plans, task_messages, task_contexts, model_configs, conversations",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT 'auto',
          model_params TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER DEFAULT 0,
          inherit_context INTEGER DEFAULT 0,
          parent_task_id TEXT,
          thread_id TEXT,
          result TEXT,
          error TEXT,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          created_by TEXT,
          FOREIGN KEY(parent_task_id) REFERENCES tasks(id)
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

        CREATE TABLE IF NOT EXISTS task_plans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          step_number INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'pending',
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_task_plans_task ON task_plans(task_id, step_number);

        CREATE TABLE IF NOT EXISTS task_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          plan_step_id INTEGER,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          message_type TEXT,
          model_used TEXT,
          token_count INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY(plan_step_id) REFERENCES task_plans(id)
        );

        CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);

        CREATE TABLE IF NOT EXISTS task_contexts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          context_type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS model_configs (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          is_enabled INTEGER DEFAULT 1,
          is_default INTEGER DEFAULT 0,
          config_json TEXT,
          updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          title TEXT,
          total_tokens INTEGER DEFAULT 0,
          last_model TEXT,
          model_response_ids TEXT,
          status TEXT DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_conversations_task ON conversations(task_id, updated_at);

        CREATE TABLE IF NOT EXISTS conversation_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          task_id TEXT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          model_id TEXT,
          token_count INTEGER DEFAULT 0,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_conv_messages ON conversation_messages(conversation_id, created_at);
      `);
    },
  },
  {
    version: 3,
    description: "Models - remove hardcoded seed configs",
    up: () => {},
  },
  {
    version: 4,
    description: "Task ordering - add queue_order to tasks",
    up: (db) => {
      const names = getTableColumnNames(db, "tasks");
      if (!names.has("queue_order")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN queue_order INTEGER`);
      }

      db.exec(`
        UPDATE tasks
        SET queue_order = created_at
        WHERE queue_order IS NULL
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_queue_order
          ON tasks(status, priority DESC, queue_order ASC, created_at ASC)
      `);
    },
  },
  {
    version: 5,
    description: "Task queue - add queued_at to tasks for delayed enqueue UX",
    up: (db) => {
      const names = getTableColumnNames(db, "tasks");
      if (!names.has("queued_at")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN queued_at INTEGER`);
      }

      db.exec(`
        UPDATE tasks
        SET queued_at = COALESCE(queued_at, created_at)
        WHERE status = 'queued' AND queued_at IS NULL
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_queued_at
          ON tasks(status, priority DESC, queue_order ASC, queued_at ASC, created_at ASC)
      `);
    },
  },
  {
    version: 6,
    description: "Attachments - add attachments table for image uploads",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          kind TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
        CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id, created_at DESC);
      `);
    },
  },
  {
    version: 7,
    description: "Task queue - add prompt_injected_at for delayed prompt injection idempotency",
    up: (db) => {
      const names = getTableColumnNames(db, "tasks");
      if (!names.has("prompt_injected_at")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN prompt_injected_at INTEGER`);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_prompt_injected_at
          ON tasks(prompt_injected_at, created_at DESC)
      `);
    },
  },
  {
    version: 8,
    description: "Attachments - store original filename",
    up: (db) => {
      const names = getTableColumnNames(db, "attachments");
      if (!names.has("filename")) {
        db.exec(`ALTER TABLE attachments ADD COLUMN filename TEXT`);
      }
    },
  },
  {
    version: 9,
    description: "Models - remove hardcoded seed configs (continued)",
    up: () => {},
  },
  {
    version: 10,
    description: "Tasks - add archived_at for completed task auto-archive + retention purge",
    up: (db) => {
      const names = getTableColumnNames(db, "tasks");
      if (!names.has("archived_at")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN archived_at INTEGER`);
      }

      // Backfill: archive existing completed tasks so the default UI no longer shows them.
      db.exec(`
        UPDATE tasks
        SET archived_at = COALESCE(archived_at, completed_at, created_at)
        WHERE status = 'completed' AND archived_at IS NULL
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_archived_at
          ON tasks(archived_at, completed_at DESC, created_at DESC)
      `);
    },
  },
  {
    version: 11,
    description: "Tasks - add agent_id for explicit CLI agent selection",
    up: (db) => {
      const names = getTableColumnNames(db, "tasks");
      if (!names.has("agent_id")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN agent_id TEXT`);
      }
    },
  },
  {
    version: 12,
    description: "Scheduler - schedules and schedule_runs",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id TEXT PRIMARY KEY,
          instruction TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          next_run_at INTEGER,
          lease_owner TEXT,
          lease_until INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_schedules_due
          ON schedules(enabled, next_run_at, id);

        CREATE INDEX IF NOT EXISTS idx_schedules_lease_until
          ON schedules(lease_until, id);

        CREATE TABLE IF NOT EXISTS schedule_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          schedule_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          run_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          task_id TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_external_id
          ON schedule_runs(external_id);

        CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id_run_at
          ON schedule_runs(schedule_id, run_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_schedule_runs_status_run_at
          ON schedule_runs(status, run_at DESC, id DESC);
      `);
    },
  },
  {
    version: 13,
    description: "Web review workflow - task review fields, review snapshots, review queue",
    up: (db) => {
      const taskNames = getTableColumnNames(db, "tasks");
      if (!taskNames.has("review_required")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0`);
      }
      if (!taskNames.has("review_status")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none'`);
      }
      if (!taskNames.has("review_snapshot_id")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN review_snapshot_id TEXT`);
      }
      if (!taskNames.has("review_conclusion")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN review_conclusion TEXT`);
      }
      if (!taskNames.has("reviewed_at")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN reviewed_at INTEGER`);
      }

      db.exec(`
        UPDATE tasks
        SET review_required = COALESCE(review_required, 0)
        WHERE review_required IS NULL
      `);
      db.exec(`
        UPDATE tasks
        SET review_status = COALESCE(review_status, 'none')
        WHERE review_status IS NULL OR TRIM(COALESCE(review_status, '')) = ''
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_review_status
          ON tasks(review_status, completed_at DESC, created_at DESC, id DESC)
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS review_snapshots (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          spec_ref TEXT,
          patch_json TEXT,
          changed_files_json TEXT NOT NULL,
          lint_summary TEXT NOT NULL DEFAULT '',
          test_summary TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_review_snapshots_task_id
          ON review_snapshots(task_id, created_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS review_queue_items (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          conclusion TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY(snapshot_id) REFERENCES review_snapshots(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_review_queue_status_created_at
          ON review_queue_items(status, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS idx_review_queue_task_id
          ON review_queue_items(task_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_review_queue_snapshot_id
          ON review_queue_items(snapshot_id);
      `);
    },
  },
  {
    version: 14,
    description: "Graph edges - add indexes on source and target for traversal performance",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      `);
    },
  },
  // 示例：未来的迁移
  // {
  //   version: 15,
  //   description: "Add tags column to nodes",
  //   up: (db) => {
  //     // 检查列是否存在
  //     const columns = db.pragma("table_info(nodes)") as Array<{ name: string }>;
  //     if (!columns.some(col => col.name === "tags")) {
  //       db.exec("ALTER TABLE nodes ADD COLUMN tags TEXT");
  //     }
  //   },
  // },
];

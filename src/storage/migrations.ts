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
  // 示例：未来的迁移
  // {
  //   version: 2,
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

# ADS 双库存储架构收敛规范 (Dual-Database Storage Consolidation Spec)

> **文档状态**：Draft（等待 Review）
> **作者**：Codex (Collaborating with Andy)
> **目标分支**：dev
> **涉及范围**：server/storage/, server/tasks/, server/scheduler/, server/attachments/, server/skills/, tests/

---

## 1. 背景与问题陈述 (Context & Problem Statement)

### 1.1 现状
当前 ADS 采用“全局控制库 + 每个工作区独立数据库”的多文件混合架构：
- **全局控制面**：$ADS_STATE_DIR/state.db（约 29.24 MB），承载 Web 鉴权、全局规则、模型配置、会话历史（history_entries）以及高频 WebSocket 实时同步流水（sync_events，占 80%+ 体积）。
- **工作区数据面**：每个工作区在 $ADS_STATE_DIR/workspaces/<workspace-id>/ads.db 中维护一个独立的 SQLite 数据库，存放任务看板（tasks）、调度器（schedules）、附件（attachments）和 Hermes FTS5 全文搜索表。

### 1.2 现有架构痛点 (Pain Points)
1. **测试目录污染与文件膨胀 (Test Artifact Pollution)**：由于单测未完全隔离 ADS_STATE_DIR，每次运行测试都会在正式状态目录下生成随机 workspace 目录与 ads.db，导致此前生成了 1,900+ 个无主残余目录。
2. **双套 Migration 与连接管理复杂度**：系统并存 server/state/schemaMigrations.ts 与 server/storage/migrations.ts，维护心智负担重，且 WorkspaceDatabase 需依赖动态解析路径与 WeakMap 缓存。
3. **跨项目聚合与看板受限**：若未来需要在 Web 控制台展示多项目任务大盘或全局调度概览，多数据库文件无法直接通过 SQL JOIN / GROUP BY 聚合，必须在应用层做多库 Fan-out 内存合并。

---

## 2. 目标架构设计 (Target Architecture)

系统收敛为固定的 **双库架构 (Fixed 2-Database Model)**：

```text
$ADS_STATE_DIR/ (~/.local/state/ads/)
├── state.db          [热流/控制面] -> WebSocket 流水(sync_events)、鉴权(web_sessions)、全局规则、会话历史
└── workspaces.db     [业务/知识库] -> 所有工作区的任务(tasks)、调度(schedules)、附件(attachments)、Hermes FTS5
```

```text
+-----------------------------------------------------------------------------+
|                               ADS 服务层 (Server Core)                       |
+--------------------------------------+--------------------------------------+
                                       |
                  +--------------------+--------------------+
                  |                                         |
                  v                                         v
  +-------------------------------+         +-------------------------------+
  |     StateDatabase (state.db)  |         | WorkspacesDatabase            |
  |   - 职责: 控制面 + 实时流式   |         |   (workspaces.db)             |
  |   - 特征: 高频追加、全局单一  |         |   - 职责: 多项目业务与知识库  |
  |   - 表:                       |         |   - 特征: 结构化状态、FTS 索引|
  |     * sync_events (WebSocket) |         |   - 隔离: workspace_id 列     |
  |     * history_entries         |         |   - 表:                       |
  |     * history_session_links   |         |     * tasks, task_plans       |
  |     * web_sessions, web_users |         |     * task_messages, runs     |
  |     * global_rules, configs   |         |     * schedules, schedule_runs|
  |     * thread_state            |         |     * attachments             |
  +-------------------------------+         |     * conversations, msgs     |
                                            |     * FTS5 全文索引虚表       |
                                            +-------------------------------+
```

### 核心设计原则
1. **动静分离 / 锁隔离**：高频流式写入（sync_events）与低频结构化任务/FTS 索引完全物理隔离，互不阻塞写锁。
2. **多租户列隔离 (Multi-Tenancy by Column)**：所有工作区业务表均包含 workspace_id TEXT NOT NULL，通过 (workspace_id, ...) 复合主键与联合索引保证查询性能与隔离性。
3. **单例连接与生命周期自闭环**：WorkspacesDatabase 为单例连接（启用 WAL 模式与 busy_timeout=5000），彻底废除动态分库查找与 WeakMap 缓存。
4. **无感自动迁移 (Zero-Downtime Auto-Migration)**：服务首次启动时自动将旧 workspaces/*/ads.db 数据无损回填入 workspaces.db。
5. **单测强制沙箱化**：单测全局 Hook 强制使用隔离的临时目录，杜绝文件泄漏。

---

## 3. 数据模型与 Schema 设计 (Schema Specifications)

workspaces.db 中的全量数据表与索引规范如下：

### 3.1 核心任务与计划表
```sql
-- 任务主表
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','pending','running','completed','failed','cancelled','archived')),
  priority INTEGER NOT NULL DEFAULT 100,
  queue_order REAL NOT NULL DEFAULT 0,
  queued_at INTEGER,
  prompt_injected_at INTEGER,
  agent_id TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  review_status TEXT,
  review_notes TEXT,
  review_rating INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status, queue_order);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created ON tasks(workspace_id, created_at);

-- 任务计划明细
CREATE TABLE IF NOT EXISTS task_plans (
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, step_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_plans_ws ON task_plans(workspace_id, task_id);

-- 任务过程消息
CREATE TABLE IF NOT EXISTS task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  message_type TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_messages_ws_task ON task_messages(workspace_id, task_id, created_at);

-- 任务执行上下文
CREATE TABLE IF NOT EXISTS task_contexts (
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  context_key TEXT NOT NULL,
  context_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, context_key),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 任务运行实例
CREATE TABLE IF NOT EXISTS task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT,
  model_id TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_text TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_runs_ws_task ON task_runs(workspace_id, task_id, started_at);
```

### 3.2 定时调度表 (Scheduler)
```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  lease_owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_ws ON schedules(workspace_id, enabled, next_run_at);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  external_id TEXT NOT NULL UNIQUE,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_ws ON schedule_runs(workspace_id, schedule_id, run_at);
```

### 3.3 附件表 (Attachments)
```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_ws_sha ON attachments(workspace_id, sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_ws_task ON attachments(workspace_id, task_id);
```

### 3.4 会话与 Hermes FTS5 全文搜索
```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_ws ON conversations(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conv_messages_ws ON conversation_messages(workspace_id, conversation_id, created_at);

-- FTS5 全文检索虚表 (带 workspace_id 过滤)
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
  content,
  workspace_id UNINDEXED,
  content='conversation_messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS conv_msg_ai AFTER INSERT ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(rowid, content, workspace_id) VALUES (new.id, new.content, new.workspace_id);
END;

CREATE TRIGGER IF NOT EXISTS conv_msg_ad AFTER DELETE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content, workspace_id) VALUES('delete', old.id, old.content, old.workspace_id);
END;

CREATE TRIGGER IF NOT EXISTS conv_msg_au AFTER UPDATE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content, workspace_id) VALUES('delete', old.id, old.content, old.workspace_id);
  INSERT INTO conversation_messages_fts(rowid, content, workspace_id) VALUES (new.id, new.content, new.workspace_id);
END;
```

---

## 4. 模块重构与接口改造规范 (Module Refactoring)

### 4.1 server/storage/database.ts
- **路径解析**：
  - 新增 `resolveWorkspacesDbPath(explicitPath?: string): string` -> 默认 `$ADS_STATE_DIR/workspaces.db`。
- **连接管理**：
  - 废除基于 workspace 路径的 `cachedDbs: Map<string, DatabaseType>`。
  - 改为单例 `getWorkspacesDatabase(explicitPath?: string): DatabaseType`。
  - 保留 `getDatabase(workspacePath?: string)` 作为向后兼容别名，内部统一重定向至单例 `getWorkspacesDatabase()`，确保平滑过渡。

### 4.2 server/tasks/store_impl.ts & storeStatements.ts
- `TaskStore` 构造时接收 `workspaceId: string`（或通过 `workspacePath` 计算 `deriveWorkspaceStateId`）。
- 所有 CRUD Statement 均绑定 `workspace_id`：
  ```typescript
  // 示例：更新任务查询
  getTaskStmt = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? AND id = ? LIMIT 1');
  listTasksStmt = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY queue_order ASC, created_at ASC');
  ```

### 4.3 server/scheduler/store.ts & server/attachments/store.ts
- `SchedulerStore` / `AttachmentStore` 构造时持有 `workspaceId`，所有查询和写入附带 `workspace_id`。

### 4.4 server/skills/builtinTools.ts (Hermes Memory FTS)
- `searchSessionMessages` 查询修改为：
  ```sql
  SELECT conversation_messages.conversation_id AS session_id,
         conversation_messages.role AS role,
         conversation_messages.created_at AS created_at,
         snippet(conversation_messages_fts, 0, '[', ']', '…', 12) AS snippet
  FROM conversation_messages_fts
  JOIN conversation_messages ON conversation_messages.id = conversation_messages_fts.rowid
  WHERE conversation_messages_fts MATCH ? AND conversation_messages_fts.workspace_id = ?
  ORDER BY bm25(conversation_messages_fts)
  LIMIT ?;
  ```

---

## 5. 数据回填与无感迁移策略 (Migration & Backfill Strategy)

启动时通过 `migrateLegacyWorkspacesToCentralDb(targetDb: DatabaseType)` 自动执行（幂等）：

1. **扫描存量文件**：遍历 `~/.local/state/ads/workspaces/*`，提取每个目录名作为 `workspace_id`，定位其中的 `ads.db`；
2. **数据迁移事务**：
   - 使用 `ATTACH DATABASE '<legacy_ads_db>' AS legacy_db;`
   - `INSERT OR IGNORE INTO main.tasks (..., workspace_id) SELECT ..., '<ws_id>' FROM legacy_db.tasks;`
   - 依次迁移 `task_plans`, `task_messages`, `schedules`, `schedule_runs`, `attachments`, `conversations`, `conversation_messages`；
   - `DETACH DATABASE legacy_db;`
3. **归档与防重入**：将旧 `ads.db` 重命名为 `ads.db.migrated.bak`，防止重复导入；
4. **记录迁移审计标记**：在 `kv_state` 中写入 `workspaces_consolidation_completed = 1`。

---

## 6. 单测沙箱隔离治理规范 (Test Sandboxing)

彻底根治单测产生垃圾目录的问题：
1. 在 `tests/helpers/testStateDir.ts` 中提供测试隔离套件：
   ```typescript
   export function setupTestStateSandbox(): { stateDir: string; cleanup: () => void } {
     const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-test-state-"));
     process.env.ADS_STATE_DIR = tmpDir;
     process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
     return {
       stateDir: tmpDir,
       cleanup: () => {
         try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
       }
     };
   }
   ```
2. 在 Vitest 全局生命周期中统一调用，所有测试产生的数据库文件自动局限在 `/tmp/ads-test-state-*`，并在测试结束后即时销毁。

---

## 7. 风险评估与回滚方案 (Risk & Rollback)

- **写锁竞争风险**：虽然所有工作区共享 `workspaces.db`，但由于任务状态更新和调度执行属于低频写入（秒级/分钟级），且启用了 WAL 模式和 5000ms `busy_timeout`，写争用风险极低。
- **数据跨租户串扰风险**：通过 TypeScript 强类型（构造 Store 必传 `workspaceId`）与单元测试校验每个查询的 `WHERE workspace_id = ?`。
- **回滚机制 (Rollback Plan)**：
  - 迁移前自动为现存 10 个 `ads.db` 创建备份；
  - 若上线后发现异常，只需切回上一提交版本，并将 `ads.db.migrated.bak` 恢复为 `ads.db`，无数据丢失风险。

---

## 8. 实施阶段计划 (Execution Phases)

| 阶段 | 核心任务 | 交付物 |
| :--- | :--- | :--- |
| **Phase 1** | 单测沙箱化机制实现 | `tests/helpers/testStateDir.ts`，拦截单测对宿主目录的写入 |
| **Phase 2** | `workspaces.db` Schema 与单例管理 | 改造 `server/storage/database.ts` 与 `migrations.ts` |
| **Phase 3** | 各业务 Store 注入 `workspace_id` | 改造 TaskStore, SchedulerStore, AttachmentStore, Hermes FTS |
| **Phase 4** | 存量数据自动回填逻辑 | 实现 `migrateLegacyWorkspacesToCentralDb` 并全量测试回填 |
| **Phase 5** | 全量单测验证与真实环境迁移验证 | `npm run test` 全绿，重启用户级 systemd 服务并验证 Web 状态 |

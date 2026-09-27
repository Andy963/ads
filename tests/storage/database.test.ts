import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getDatabase, getDatabaseInfo, getWorkspacesDatabase, resetDatabaseForTests, resolveWorkspaceId, SCHEMA_VERSION } from "../../server/storage/database.js";
import { withWorkspaceContext } from "../../server/workspace/asyncWorkspaceContext.js";
import { initializeWorkspace } from "../../server/workspace/detector.js";
import { deriveWorkspaceStateId, resolveWorkspaceStatePath } from "../../server/workspace/adsPaths.js";
import { installTempAdsStateDir } from "../helpers/adsStateDir.js";
import { AttachmentStore } from "../../server/attachments/store.js";
import { ScheduleStore } from "../../server/scheduler/store.js";
import { searchSessionMessages } from "../../server/skills/builtinTools.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";
import { migrateLegacyWorkspacesToCentralDb } from "../../server/storage/legacyWorkspaceMigration.js";

describe("storage/database", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 创建临时目录
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-db-test-"));
    dbPath = path.join(tmpDir, "test.db");
    
    // 设置环境变量指向测试数据库
    process.env.ADS_DATABASE_PATH = dbPath;
    process.env.ADS_SQLITE_BUSY_TIMEOUT_MS = "1234";
    
    // 重置数据库缓存
    resetDatabaseForTests();
  });

  afterEach(() => {
    // 重置数据库缓存
    resetDatabaseForTests();
    
    // 恢复环境变量
    process.env = { ...originalEnv };
    
    // 清理临时文件
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should create database file", () => {
    const db = getDatabase();
    assert.ok(db, "Database should be created");
    assert.ok(fs.existsSync(dbPath), "Database file should exist");
  });

  it("should return cached database instance", () => {
    const db1 = getDatabase();
    const db2 = getDatabase();
    assert.strictEqual(db1, db2, "Should return same cached instance");
  });

  it("should not create legacy workflow/graph tables for a fresh database", () => {
    const db = getDatabase();
    const legacyTables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name IN ('nodes', 'edges', 'node_versions', 'workflow_commits')
         ORDER BY name ASC`
      )
      .all() as Array<{ name: string }>;

    assert.deepStrictEqual(legacyTables, [], "Fresh database should not create removed workflow/graph tables");
  });

  it("should enable WAL mode", () => {
    const db = getDatabase();
    const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    assert.strictEqual(result[0].journal_mode, "wal", "Should use WAL journal mode");
  });

  it("should enable foreign keys", () => {
    const db = getDatabase();
    const result = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
    assert.strictEqual(result[0].foreign_keys, 1, "Foreign keys should be enabled");
  });

  it("should set busy timeout", () => {
    const db = getDatabase();
    const timeoutMs = db.pragma("busy_timeout", { simple: true }) as number;
    assert.strictEqual(timeoutMs, 1234, "Busy timeout should match configuration");
  });

  it("should upgrade legacy workflow databases without schema_version metadata", () => {
    resetDatabaseForTests();
    const seedDb = getDatabase();
    const now = new Date().toISOString();
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    seedDb.prepare(`
      INSERT INTO nodes (id, type, label, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy-node-1", "requirement", "Legacy Node", "legacy content", now, now);
    seedDb.exec("DROP TABLE schema_version");

    resetDatabaseForTests();
    const db = getDatabase();
    const info = getDatabaseInfo();
    const node = db.prepare("SELECT id, label FROM nodes WHERE id = ?").get("legacy-node-1") as { id: string; label: string };

    assert.strictEqual(info.needsMigration, false);
    assert.strictEqual(node.id, "legacy-node-1");
    assert.strictEqual(node.label, "Legacy Node");
  });

  it("should create model_configs table without hardcoded seeds", () => {
    const db = getDatabase();
    const tableInfo = db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name: string }>;
    assert.ok(tableInfo.length > 0, "model_configs table should exist");

    const ids = (db.prepare("SELECT id FROM model_configs ORDER BY id ASC").all() as Array<{ id: string }>).map((row) => row.id);
    assert.deepStrictEqual(ids, [], "Should not seed model configs by default");
  });

  it("should reset database cache correctly", () => {
    const db1 = getDatabase();
    assert.ok(db1, "First database should be created");
    
    resetDatabaseForTests();
    
    const db2 = getDatabase();
    assert.ok(db2, "Second database should be created");
    assert.notStrictEqual(db1, db2, "Should be different instances after reset");
  });

  it("should normalize relative ADS_DATABASE_PATH in database info", () => {
    const previousCwd = process.cwd();
    const relativeDbPath = path.join("relative", "test.db");
    fs.mkdirSync(path.join(tmpDir, "relative"), { recursive: true });
    process.chdir(tmpDir);
    process.env.ADS_DATABASE_PATH = relativeDbPath;
    resetDatabaseForTests();

    try {
      const info = getDatabaseInfo();
      assert.strictEqual(info.path, path.join(tmpDir, relativeDbPath));
      assert.ok(fs.existsSync(info.path), "Relative override should be materialized as an absolute file path");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("should resolve nested workspace paths through workspace root in database info", () => {
    const adsState = installTempAdsStateDir("ads-storage-db-test-");
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-storage-workspace-"));
    fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
    const nestedDir = path.join(workspaceDir, "nested", "dir");
    fs.mkdirSync(nestedDir, { recursive: true });

    delete process.env.ADS_DATABASE_PATH;
    resetDatabaseForTests();

    try {
      initializeWorkspace(workspaceDir, "Storage Workspace");
      const info = getDatabaseInfo(nestedDir);
      assert.strictEqual(info.path, resolveWorkspaceStatePath(workspaceDir, "ads.db"));
      assert.ok(fs.existsSync(info.path), "Workspace database should be created under the resolved workspace root");
    } finally {
      adsState.restore();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("should resolve async workspace context through workspace root in database info", async () => {
    const adsState = installTempAdsStateDir("ads-storage-db-context-");
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-storage-context-"));
    fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
    const nestedDir = path.join(workspaceDir, "nested", "context");
    fs.mkdirSync(nestedDir, { recursive: true });

    delete process.env.ADS_DATABASE_PATH;
    resetDatabaseForTests();

    try {
      initializeWorkspace(workspaceDir, "Storage Context Workspace");
      const info = await withWorkspaceContext(nestedDir, () => getDatabaseInfo());
      assert.strictEqual(info.path, resolveWorkspaceStatePath(workspaceDir, "ads.db"));
      assert.ok(fs.existsSync(info.path), "Async workspace context should resolve to the workspace root database");
    } finally {
      adsState.restore();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("should backfill review snapshot task_run_id when upgrading from schema version 14", () => {
    const db = getDatabase();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("task-1", "Task", "Prompt", "auto", "completed", createdAt);
    db.prepare(
      `INSERT INTO task_runs (
         id, task_id, execution_isolation, workspace_root, worktree_dir,
         branch_name, base_head, end_head, status, capture_status, apply_status, error,
         created_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-1",
      "task-1",
      "required",
      "/tmp/workspace",
      "/tmp/worktree",
      "task-run-1",
      "base-head",
      "end-head",
      "completed",
      "ok",
      "pending",
      null,
      createdAt,
      createdAt,
      createdAt,
    );
    db.prepare(
      `INSERT INTO review_snapshots (
         id, task_id, task_run_id, spec_ref, patch_json, changed_files_json,
         lint_summary, test_summary, created_at
       ) VALUES (?, ?, NULL, NULL, NULL, ?, '', '', ?)`,
    ).run("snapshot-1", "task-1", JSON.stringify(["note.txt"]), createdAt + 1);
    db.prepare("UPDATE schema_version SET version = 14 WHERE id = 1").run();

    resetDatabaseForTests();

    const migrated = getDatabase();
    const row = migrated
      .prepare("SELECT task_run_id FROM review_snapshots WHERE id = ?")
      .get("snapshot-1") as { task_run_id: string | null };
    assert.strictEqual(row.task_run_id, "run-1");
  });

  it("should repair legacy schema-v17 task_runs columns when upgrading to schema version 18", () => {
    const db = getDatabase();
    db.exec(`
      DROP TABLE IF EXISTS task_runs;
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        worktree_dir TEXT,
        branch_name TEXT,
        base_head TEXT,
        start_head TEXT,
        end_head TEXT,
        status TEXT NOT NULL,
        capture_status TEXT NOT NULL DEFAULT 'pending',
        capture_error TEXT,
        apply_status TEXT NOT NULL DEFAULT 'pending',
        apply_error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    db.prepare("UPDATE schema_version SET version = 17 WHERE id = 1").run();

    resetDatabaseForTests();

    const migrated = getDatabase();
    const taskRunCols = (
      migrated.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.ok(taskRunCols.includes("execution_isolation"));
    assert.ok(taskRunCols.includes("error"));

    const version = migrated.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    assert.strictEqual(version.version, SCHEMA_VERSION);
  });

  it("should add task-run cleanup lifecycle columns and backfill legacy rows", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("cleanup-task", "Task", "Prompt", "auto", "completed", Date.now());
    db.prepare(
      `INSERT INTO task_runs (
         id, task_id, execution_isolation, workspace_root, worktree_dir,
         branch_name, base_head, end_head, status, capture_status, apply_status, error,
         created_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "cleanup-run",
      "cleanup-task",
      "required",
      "/tmp/workspace",
      "/tmp/worktree",
      "ads/task/cleanup",
      "base",
      "end",
      "completed",
      "ok",
      "skipped",
      null,
      Date.now(),
      Date.now(),
      Date.now(),
    );
    db.prepare("UPDATE schema_version SET version = 28 WHERE id = 1").run();

    resetDatabaseForTests();

    const migrated = getDatabase();
    const columns = (migrated.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(columns.includes("cleanup_status"));
    assert.ok(columns.includes("cleanup_error"));
    assert.ok(columns.includes("cleanup_at"));
    const run = migrated.prepare("SELECT cleanup_status FROM task_runs WHERE id = ?").get("cleanup-run") as { cleanup_status: string };
    assert.equal(run.cleanup_status, "pending");
    const version = migrated.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    assert.equal(version.version, SCHEMA_VERSION);
  });

  it("should repair invalid workspace references before installing enforcement triggers", () => {
    const db = getDatabase();
    db.exec(`
      DROP TRIGGER enforce_conversation_messages_conversation_id_insert;
      DROP TRIGGER enforce_conversation_messages_conversation_id_update;
      DROP TRIGGER enforce_tasks_parent_task_id_insert;
      DROP TRIGGER enforce_tasks_parent_task_id_update;
    `);
    db.prepare("UPDATE schema_version SET version = 25 WHERE id = 1").run();
    db.prepare(
      `INSERT INTO conversations (workspace_id, id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("workspace-a", "chat-1", 1, 1);
    db.prepare(
      `INSERT INTO conversation_messages (workspace_id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-b", "chat-1", "user", "orphan message", 2);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO tasks (workspace_id, id, title, prompt, model, status, created_at, parent_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("workspace-b", "task-1", "Task", "Prompt", "auto", "pending", 3, "missing-parent");
    db.pragma("foreign_keys = ON");

    resetDatabaseForTests();

    const migrated = getDatabase();
    const messageCount = migrated.prepare("SELECT COUNT(*) AS count FROM conversation_messages").get() as { count: number };
    const task = migrated.prepare("SELECT parent_task_id FROM tasks WHERE id = ?").get("task-1") as { parent_task_id: string | null };
    const repairs = migrated
      .prepare("SELECT table_name, column_name, action, reference_value FROM workspace_reference_repairs ORDER BY id")
      .all() as Array<{ table_name: string; column_name: string; action: string; reference_value: string }>;
    const version = migrated.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };

    assert.strictEqual(version.version, SCHEMA_VERSION);
    assert.strictEqual(messageCount.count, 0);
    assert.strictEqual(task.parent_task_id, null);
    assert.deepStrictEqual(repairs, [
      {
        table_name: "tasks",
        column_name: "parent_task_id",
        action: "nullify",
        reference_value: "missing-parent",
      },
      {
        table_name: "conversation_messages",
        column_name: "conversation_id",
        action: "delete",
        reference_value: "chat-1",
      },
    ]);

    assert.throws(
      () => migrated.prepare(
        `INSERT INTO conversation_messages (workspace_id, conversation_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("workspace-b", "chat-1", "user", "blocked", 4),
      /conversation_messages\.conversation_id workspace mismatch/,
    );
    migrated.prepare(
      `INSERT INTO conversation_messages (workspace_id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-a", "chat-1", "user", "valid", 5);
  });

  it("should defer restrictive foreign keys while repairing dependent rows", () => {
    const db = getDatabase();
    db.exec(`
      DROP TRIGGER enforce_task_plans_task_id_insert;
      DROP TRIGGER enforce_task_plans_task_id_update;
      DROP TRIGGER enforce_task_messages_plan_step_id_insert;
      DROP TRIGGER enforce_task_messages_plan_step_id_update;
    `);
    db.prepare("UPDATE schema_version SET version = 25 WHERE id = 1").run();
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO tasks (workspace_id, id, title, prompt, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("workspace-a", "task-1", "Task", "Prompt", "auto", "pending", 1);
    db.prepare(
      `INSERT INTO task_plans (workspace_id, id, task_id, step_number, title)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-a", 99, "missing-task", 1, "Orphan plan");
    db.prepare(
      `INSERT INTO task_messages (workspace_id, task_id, plan_step_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("workspace-a", "task-1", 99, "user", "Dependent message", 2);
    db.pragma("foreign_keys = ON");

    resetDatabaseForTests();

    const migrated = getDatabase();
    const plan = migrated.prepare("SELECT COUNT(*) AS count FROM task_plans WHERE id = 99").get() as { count: number };
    const message = migrated.prepare("SELECT plan_step_id FROM task_messages WHERE content = ?").get("Dependent message") as { plan_step_id: number | null };
    const repairs = migrated
      .prepare("SELECT table_name, column_name, action FROM workspace_reference_repairs ORDER BY id")
      .all() as Array<{ table_name: string; column_name: string; action: string }>;

    assert.strictEqual(plan.count, 0);
    assert.strictEqual(message.plan_step_id, null);
    assert.deepStrictEqual(repairs, [
      { table_name: "task_plans", column_name: "task_id", action: "delete" },
      { table_name: "task_messages", column_name: "plan_step_id", action: "nullify" },
    ]);
  });

  describe("migration v22: tasks goal_* columns", () => {
    it("adds goal_mode/goal_objective/goal_token_budget/goal_status/goal_tokens_used/goal_time_used_seconds columns to tasks", () => {
      const db = getDatabase();
      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name?: string }>;
      const names = new Set(cols.map((c) => String(c.name ?? "").trim()).filter(Boolean));
      assert.ok(names.has("goal_mode"), "goal_mode column missing");
      assert.ok(names.has("goal_objective"), "goal_objective column missing");
      assert.ok(names.has("goal_token_budget"), "goal_token_budget column missing");
      assert.ok(names.has("goal_status"), "goal_status column missing");
      assert.ok(names.has("goal_tokens_used"), "goal_tokens_used column missing");
      assert.ok(names.has("goal_time_used_seconds"), "goal_time_used_seconds column missing");
    });

    it("defaults goal_mode to 0 for newly inserted rows that don't specify it", () => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, model, status, created_at)
         VALUES ('t-goal', 'x', 'p', 'auto', 'pending', ?)`,
      ).run(Date.now());
      const row = db.prepare(`SELECT goal_mode FROM tasks WHERE id = 't-goal'`).get() as { goal_mode?: number };
      assert.equal(row.goal_mode, 0);
    });

    it("persists goal fields when set explicitly", () => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, model, status, created_at, goal_mode, goal_objective, goal_token_budget, goal_status, goal_tokens_used, goal_time_used_seconds)
         VALUES ('t-g2', 'x', 'p', 'auto', 'pending', ?, 1, 'do X', 5000, 'active', 123, 9)`,
      ).run(Date.now());
      const row = db
        .prepare(
          `SELECT goal_mode, goal_objective, goal_token_budget, goal_status, goal_tokens_used, goal_time_used_seconds
           FROM tasks WHERE id = 't-g2'`,
        )
        .get() as Record<string, unknown>;
      assert.equal(row.goal_mode, 1);
      assert.equal(row.goal_objective, "do X");
      assert.equal(row.goal_token_budget, 5000);
      assert.equal(row.goal_status, "active");
      assert.equal(row.goal_tokens_used, 123);
      assert.equal(row.goal_time_used_seconds, 9);
    });
  });

  describe("storage/fts", () => {
    let workspace: string;

    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-fts-"));
      delete process.env.ADS_DATABASE_PATH;
      process.env.ADS_WORKSPACES_DATABASE_PATH = path.join(workspace, "workspaces.db");
      resetDatabaseForTests();
    });

    afterEach(() => {
      resetDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it("indexes conversation messages for session search", () => {
      const db = getWorkspacesDatabase(undefined, workspace);
      const workspaceId = resolveWorkspaceId(workspace);
      db.prepare(
        "INSERT INTO conversations (workspace_id, id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(workspaceId, "chat-1", "Chat", "active", 123, 123);
      db.prepare(
        "INSERT INTO conversation_messages (workspace_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(workspaceId, "chat-1", "user", "The tavily request failed with error 429", 123);

      const matches = searchSessionMessages({ workspaceRoot: workspace, query: "tavily" });
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.sessionId, "chat-1");
      assert.match(matches[0]?.snippet ?? "", /tavily/i);
    });
  });

  describe("ThreadStorage", () => {
    it("stores thread IDs per agent", () => {
      const threadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));

      const storage = new ThreadStorage({
        namespace: "test",
        stateDbPath: path.join(threadDir, "state.db"),
        storagePath: path.join(threadDir, "threads.json"),
        saltPath: path.join(threadDir, "thread-storage-salt"),
      });

      storage.setThreadId(42, "codex-123", "codex");
      storage.setThreadId(42, "claude-456", "claude");

      assert.equal(storage.getThreadId(42, "codex"), "codex-123");
      assert.equal(storage.getThreadId(42, "claude"), "claude-456");

      const record = storage.getRecord(42);
      assert.deepEqual(record?.agentThreads, {
        codex: "codex-123",
        claude: "claude-456",
      });

      fs.rmSync(threadDir, { recursive: true, force: true });
    });

    it("isolates Telegram state from Web lane state", () => {
      const threadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
      const stateDbPath = path.join(threadDir, "state.db");
      const options = {
        stateDbPath,
        storagePath: path.join(threadDir, "threads.json"),
        saltPath: path.join(threadDir, "thread-storage-salt"),
      };
      const telegramStorage = new ThreadStorage({ ...options, namespace: "tg" });
      const webWorkerStorage = new ThreadStorage({ ...options, namespace: "web-worker" });

      telegramStorage.setThreadId(42, "tg-codex-thread", "codex");
      webWorkerStorage.setThreadId(42, "web-codex-thread", "codex");

      assert.equal(telegramStorage.getThreadId(42, "codex"), "tg-codex-thread");
      assert.equal(webWorkerStorage.getThreadId(42, "codex"), "web-codex-thread");

      fs.rmSync(threadDir, { recursive: true, force: true });
    });
  });

  describe("storage/workspaces database", () => {
    let root: string;
    let workspaceA: string;
    let workspaceB: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspaces-db-"));
      workspaceA = path.join(root, "workspace-a");
      workspaceB = path.join(root, "workspace-b");
      fs.mkdirSync(workspaceA, { recursive: true });
      fs.mkdirSync(workspaceB, { recursive: true });
      delete process.env.ADS_DATABASE_PATH;
      process.env.ADS_STATE_DIR = path.join(root, "state");
      process.env.ADS_WORKSPACES_DATABASE_PATH = path.join(root, "state", "workspaces.db");
      resetDatabaseForTests();
    });

    afterEach(() => {
      resetDatabaseForTests();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("isolates task, schedule, and attachment reads by workspace", () => {
      const db = getWorkspacesDatabase(undefined, workspaceA);
      const workspaceIdA = resolveWorkspaceId(workspaceA);
      const workspaceIdB = resolveWorkspaceId(workspaceB);
      db.prepare(
        "INSERT INTO tasks (workspace_id, id, title, prompt, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(workspaceIdA, "task-a", "A", "A", "auto", "pending", 1);
      assert.equal(
        db.prepare("SELECT id FROM tasks WHERE workspace_id = ? AND id = ?").get(workspaceIdB, "task-a"),
        undefined,
      );

      const scheduleA = new ScheduleStore({ workspacePath: workspaceA }).createSchedule({
        instruction: "Run A",
        spec: {
          version: 1,
          name: "schedule-a",
          schedule: { type: "cron", cron: "0 0 * * *", timezone: "UTC" },
          instruction: "Run A",
          delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
          compiledTask: { title: "A", prompt: "A", expectedResultSchema: {}, verification: { commands: [] } },
          policy: { workspaceWrite: false, network: "deny", maxDurationMs: 600000, maxRetries: 0, concurrencyKey: "schedule:{scheduleId}", idempotencyKeyTemplate: "{scheduleId}:{runAtIso}" },
          enabled: true,
          questions: [],
        },
        enabled: true,
        nextRunAt: 1,
      });
      const scheduleStoreB = new ScheduleStore({ workspacePath: workspaceB });
      assert.equal(scheduleStoreB.getSchedule(scheduleA.id), null);
      const externalId = "shared-run-id";
      assert.equal(new ScheduleStore({ workspacePath: workspaceA }).insertRun({ scheduleId: scheduleA.id, externalId, runAt: 1, taskId: null, status: "queued" }).inserted, true);
      const scheduleB = scheduleStoreB.createSchedule({
        instruction: "Run B",
        spec: {
          version: 1, name: "schedule-b", enabled: true,
          schedule: { type: "cron", cron: "0 0 * * *", timezone: "UTC" }, instruction: "Run B",
          delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
          compiledTask: { title: "B", prompt: "B", expectedResultSchema: {}, verification: { commands: [] } },
          policy: { workspaceWrite: false, network: "deny", maxDurationMs: 600000, maxRetries: 0, concurrencyKey: "schedule:{scheduleId}", idempotencyKeyTemplate: "{scheduleId}:{runAtIso}" },
          questions: [],
        },
        enabled: true,
        nextRunAt: 1,
      });
      assert.equal(scheduleStoreB.insertRun({ scheduleId: scheduleB.id, externalId, runAt: 1, taskId: null, status: "queued" }).inserted, true);

      const attachmentA = new AttachmentStore({ workspacePath: workspaceA }).createOrGetImageAttachment({
        contentType: "image/png", sizeBytes: 1, width: 1, height: 1,
        sha256: "a".repeat(64), storageKey: "attachments/a.png",
      });
      const attachmentStoreB = new AttachmentStore({ workspacePath: workspaceB });
      assert.equal(attachmentStoreB.getAttachment(attachmentA.id), null);
      const attachmentB = attachmentStoreB.createOrGetImageAttachment({
        contentType: "image/png", sizeBytes: 1, width: 1, height: 1,
        sha256: "a".repeat(64), storageKey: "attachments/b.png",
      });
      assert.notEqual(attachmentB.id, attachmentA.id);

      db.prepare(
        "INSERT INTO conversations (workspace_id, id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(workspaceIdA, "shared-conversation", "A", "active", 1, 1);
      assert.equal(
        (db.prepare("SELECT title FROM conversations WHERE workspace_id = ? AND id = ?").get(workspaceIdA, "shared-conversation") as { title?: string } | undefined)?.title,
        "A",
      );
      assert.equal(
        db.prepare("SELECT id FROM conversations WHERE workspace_id = ? AND id = ?").get(workspaceIdB, "shared-conversation"),
        undefined,
      );

      assert.throws(
        () => db.prepare(
          "INSERT INTO task_messages (workspace_id, task_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(workspaceIdB, "task-a", "user", "cross-workspace reference", 1),
        /task_messages.task_id workspace mismatch/,
      );
    });

    it("imports a legacy workspace database once without modifying the source", () => {
      const workspacesDir = path.join(root, "legacy-workspaces");
      const workspaceId = deriveWorkspaceStateId(workspaceA);
      const sourceDir = path.join(workspacesDir, workspaceId);
      const sourcePath = path.join(sourceDir, "ads.db");
      fs.mkdirSync(sourceDir, { recursive: true });

      process.env.ADS_DATABASE_PATH = sourcePath;
      resetDatabaseForTests();
      const legacyDb = getDatabase();
      legacyDb.prepare("INSERT INTO tasks (id, title, prompt, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("legacy-task", "Legacy", "Legacy prompt", "auto", "pending", 1);
      legacyDb.prepare("INSERT INTO review_settings (workspace_id, automation_mode, max_rework_rounds, updated_at) VALUES (?, ?, ?, ?)")
        .run("legacy-workspace", "human_gated", 1, 2);
      legacyDb.prepare("INSERT INTO review_action_audits (workspace_id, id, task_id, root_task_id, action, reason, actor_id, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy-workspace", "audit-1", "legacy-task", "legacy-task", "skip_review", "legacy", "user-1", "legacy-key", 3);
      resetDatabaseForTests();
      delete process.env.ADS_DATABASE_PATH;

      const before = fs.statSync(sourcePath);
      const central = getWorkspacesDatabase();
      const first = migrateLegacyWorkspacesToCentralDb(central, { workspacesDir });
      const second = migrateLegacyWorkspacesToCentralDb(central, { workspacesDir });

      assert.equal(first.length, 1);
      assert.deepEqual(second, []);
      const migratedTask = central
        .prepare("SELECT title FROM tasks WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, "legacy-task") as { title?: string } | undefined;
      assert.equal(migratedTask?.title, "Legacy");
      const reviewSettings = central
        .prepare("SELECT automation_mode, max_rework_rounds, updated_at FROM review_settings WHERE workspace_id = ?")
        .get(workspaceId) as { automation_mode?: string; max_rework_rounds?: number; updated_at?: number } | undefined;
      assert.deepEqual(reviewSettings, {
        automation_mode: "human_gated",
        max_rework_rounds: 1,
        updated_at: 2,
      });
      const auditCount = central
        .prepare("SELECT COUNT(*) AS count FROM review_action_audits WHERE workspace_id = ? AND task_id = ?")
        .get(workspaceId, "legacy-task") as { count?: number } | undefined;
      assert.equal(auditCount?.count, 1);
      const after = fs.statSync(sourcePath);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
    });

    it("rejects an unsupported legacy schema without writing an audit row", () => {
      const workspacesDir = path.join(root, "unsupported-workspaces");
      const workspaceId = deriveWorkspaceStateId(workspaceA);
      const sourceDir = path.join(workspacesDir, workspaceId);
      const sourcePath = path.join(sourceDir, "ads.db");
      fs.mkdirSync(sourceDir, { recursive: true });

      process.env.ADS_DATABASE_PATH = sourcePath;
      resetDatabaseForTests();
      getDatabase().prepare("UPDATE schema_version SET version = 999 WHERE id = 1").run();
      resetDatabaseForTests();
      delete process.env.ADS_DATABASE_PATH;

      const central = getWorkspacesDatabase();
      assert.throws(
        () => migrateLegacyWorkspacesToCentralDb(central, { workspacesDir }),
        /Unsupported legacy schema version/,
      );
      assert.equal(
        central.prepare("SELECT COUNT(*) AS count FROM legacy_workspace_migrations WHERE source_path = ?").get(sourcePath)?.count,
        0,
      );
    });
  });
});

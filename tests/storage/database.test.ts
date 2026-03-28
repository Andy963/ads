import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getDatabase, getDatabaseInfo, resetDatabaseForTests } from "../../server/storage/database.js";
import { withWorkspaceContext } from "../../server/workspace/asyncWorkspaceContext.js";
import { initializeWorkspace } from "../../server/workspace/detector.js";
import { resolveWorkspaceStatePath } from "../../server/workspace/adsPaths.js";
import { installTempAdsStateDir } from "../helpers/adsStateDir.js";

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
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getDatabase, resetDatabaseForTests } from "../../src/storage/database.js";

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

  it("should create nodes table with correct schema", () => {
    const db = getDatabase();
    const tableInfo = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string; type: string }>;
    
    const columnNames = tableInfo.map(col => col.name);
    assert.ok(columnNames.includes("id"), "Should have id column");
    assert.ok(columnNames.includes("type"), "Should have type column");
    assert.ok(columnNames.includes("label"), "Should have label column");
    assert.ok(columnNames.includes("content"), "Should have content column");
    assert.ok(columnNames.includes("current_version"), "Should have current_version column");
    assert.ok(columnNames.includes("is_draft"), "Should have is_draft column");
  });

  it("should create edges table with correct schema", () => {
    const db = getDatabase();
    const tableInfo = db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string; type: string }>;
    
    const columnNames = tableInfo.map(col => col.name);
    assert.ok(columnNames.includes("id"), "Should have id column");
    assert.ok(columnNames.includes("source"), "Should have source column");
    assert.ok(columnNames.includes("target"), "Should have target column");
    assert.ok(columnNames.includes("edge_type"), "Should have edge_type column");
  });

  it("should create node_versions table with correct schema", () => {
    const db = getDatabase();
    const tableInfo = db.prepare("PRAGMA table_info(node_versions)").all() as Array<{ name: string; type: string }>;
    
    const columnNames = tableInfo.map(col => col.name);
    assert.ok(columnNames.includes("node_id"), "Should have node_id column");
    assert.ok(columnNames.includes("version"), "Should have version column");
    assert.ok(columnNames.includes("content"), "Should have content column");
    assert.ok(columnNames.includes("source_type"), "Should have source_type column");
  });

  it("should create workflow_commits table with correct schema", () => {
    const db = getDatabase();
    const tableInfo = db.prepare("PRAGMA table_info(workflow_commits)").all() as Array<{ name: string; type: string }>;
    
    const columnNames = tableInfo.map(col => col.name);
    assert.ok(columnNames.includes("workflow_id"), "Should have workflow_id column");
    assert.ok(columnNames.includes("node_id"), "Should have node_id column");
    assert.ok(columnNames.includes("step_name"), "Should have step_name column");
    assert.ok(columnNames.includes("version"), "Should have version column");
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

  it("should allow inserting and querying nodes", () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    
    db.prepare(`
      INSERT INTO nodes (id, type, label, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("test-node-1", "requirement", "Test Node", "Test content", now, now);
    
    const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get("test-node-1") as { id: string; label: string };
    assert.strictEqual(node.id, "test-node-1");
    assert.strictEqual(node.label, "Test Node");
  });

  it("should allow inserting and querying edges", () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    
    // 先插入节点
    db.prepare(`
      INSERT INTO nodes (id, type, label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("node-a", "requirement", "Node A", now, now);
    
    db.prepare(`
      INSERT INTO nodes (id, type, label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("node-b", "design", "Node B", now, now);
    
    // 插入边
    db.prepare(`
      INSERT INTO edges (id, source, target, edge_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("edge-1", "node-a", "node-b", "next", now, now);
    
    const edge = db.prepare("SELECT * FROM edges WHERE id = ?").get("edge-1") as { source: string; target: string };
    assert.strictEqual(edge.source, "node-a");
    assert.strictEqual(edge.target, "node-b");
  });

  it("should seed model configs", () => {
    const db = getDatabase();
    const ids = (db.prepare("SELECT id FROM model_configs ORDER BY id ASC").all() as Array<{ id: string }>).map((row) => row.id);

    assert.ok(ids.includes("gpt-5"), "Should include gpt-5");
    assert.ok(ids.includes("gpt-5.1"), "Should include gpt-5.1");
    assert.ok(ids.includes("gpt-5.2"), "Should include gpt-5.2");
    assert.ok(ids.includes("gpt-5.2-codex"), "Should include gpt-5.2-codex");
    assert.ok(ids.includes("gpt-5.1-codex-max"), "Should include gpt-5.1-codex-max");
  });

  it("should reset database cache correctly", () => {
    const db1 = getDatabase();
    assert.ok(db1, "First database should be created");
    
    resetDatabaseForTests();
    
    const db2 = getDatabase();
    assert.ok(db2, "Second database should be created");
    assert.notStrictEqual(db1, db2, "Should be different instances after reset");
  });
});

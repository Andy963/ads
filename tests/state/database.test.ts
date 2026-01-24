import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getStateDatabase, resetStateDatabaseForTests } from "../../src/state/database.js";

describe("state/database", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-state-db-test-"));
    dbPath = path.join(tmpDir, "state.db");

    process.env.ADS_STATE_DB_PATH = dbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("should create state database file", () => {
    const db = getStateDatabase();
    assert.ok(db, "State database should be created");
    assert.ok(fs.existsSync(dbPath), "State database file should exist");
  });

  it("should return cached database instance", () => {
    const db1 = getStateDatabase();
    const db2 = getStateDatabase();
    assert.strictEqual(db1, db2, "Should return same cached instance");
  });

  it("should create kv_state table", () => {
    const db = getStateDatabase();
    const tableInfo = db.prepare("PRAGMA table_info(kv_state)").all() as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);
    assert.ok(columnNames.includes("namespace"));
    assert.ok(columnNames.includes("key"));
    assert.ok(columnNames.includes("value"));
    assert.ok(columnNames.includes("updated_at"));
  });

  it("should create tasks tables", () => {
    const db = getStateDatabase();
    const taskInfo = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const taskColumns = taskInfo.map((col) => col.name);
    assert.ok(taskColumns.includes("task_id"));
    assert.ok(taskColumns.includes("status"));
    assert.ok(taskColumns.includes("spec_json"));

    const msgInfo = db.prepare("PRAGMA table_info(task_messages)").all() as Array<{ name: string }>;
    const msgColumns = msgInfo.map((col) => col.name);
    assert.ok(msgColumns.includes("task_id"));
    assert.ok(msgColumns.includes("payload"));
  });

  it("should enable WAL mode", () => {
    const db = getStateDatabase();
    const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    assert.strictEqual(result[0].journal_mode, "wal", "Should use WAL journal mode");
  });

  it("should enable foreign keys", () => {
    const db = getStateDatabase();
    const result = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
    assert.strictEqual(result[0].foreign_keys, 1, "Foreign keys should be enabled");
  });
});

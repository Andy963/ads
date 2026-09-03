import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getStateDatabase,
  getStateDatabaseInfo,
  resetStateDatabaseForTests,
} from "../../server/state/database.js";

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

  it("should create agent session history links", () => {
    const db = getStateDatabase();
    const info = db.prepare("PRAGMA table_info(history_session_links)").all() as Array<{ name: string }>;
    const columns = info.map((column) => column.name);

    assert.ok(columns.includes("namespace"));
    assert.ok(columns.includes("session_id"));
    assert.ok(columns.includes("agent_id"));
    assert.ok(columns.includes("provider_session_id"));
    assert.ok(columns.includes("locator_json"));
  });

  it("should record schema version metadata for a fresh database", () => {
    getStateDatabase();

    const info = getStateDatabaseInfo();
    assert.strictEqual(info.schemaVersion, info.latestVersion);
    assert.strictEqual(info.needsMigration, false);
  });

  it("adds Ultra only to existing Codex model configs during migration", () => {
    const seedDb = getStateDatabase();
    const rows = seedDb
      .prepare(
        `SELECT id, model_id, config_json
         FROM model_configs
         WHERE model_id IN (?, ?)`,
      )
      .all("gpt-5.5", "claude-opus-4.8") as Array<{
      id: string;
      model_id: string;
      config_json: string;
    }>;
    const update = seedDb.prepare("UPDATE model_configs SET config_json = ? WHERE id = ?");
    for (const row of rows) {
      const config = JSON.parse(row.config_json) as { reasoningEfforts?: string[] };
      config.reasoningEfforts = (config.reasoningEfforts ?? []).filter((effort) => effort !== "ultra");
      update.run(JSON.stringify(config), row.id);
    }
    seedDb.exec("UPDATE schema_version SET version = 11 WHERE id = 1");

    resetStateDatabaseForTests();

    const db = getStateDatabase();
    const configs = db
      .prepare(
        `SELECT model_id, config_json
         FROM model_configs
         WHERE model_id IN (?, ?)
         ORDER BY model_id`,
      )
      .all("gpt-5.5", "claude-opus-4.8") as Array<{ model_id: string; config_json: string }>;

    assert.deepStrictEqual(
      configs.map((row) => ({ modelId: row.model_id, reasoningEfforts: (JSON.parse(row.config_json) as { reasoningEfforts: string[] }).reasoningEfforts })),
      [
        { modelId: "claude-opus-4.8", reasoningEfforts: ["high", "xhigh", "max"] },
        { modelId: "gpt-5.5", reasoningEfforts: ["high", "xhigh", "max", "ultra"] },
      ],
    );
  });

  it("should upgrade legacy state databases without schema_version metadata", () => {
    const seedDb = getStateDatabase();
    seedDb.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("test", "legacy-key", "legacy-value", 123);
    seedDb.exec("DROP TABLE schema_version");

    resetStateDatabaseForTests();

    const db = getStateDatabase();
    const info = getStateDatabaseInfo();
    const row = db.prepare(
      `SELECT value, updated_at
       FROM kv_state
       WHERE namespace = ? AND key = ?`,
    ).get("test", "legacy-key") as { value: string; updated_at: number };

    assert.strictEqual(info.needsMigration, false);
    assert.strictEqual(info.schemaVersion, info.latestVersion);
    assert.strictEqual(row.value, "legacy-value");
    assert.strictEqual(row.updated_at, 123);
  });

  it("dedupes history client messages by id after metadata-bearing kind migration", () => {
    const seedDb = getStateDatabase();
    seedDb.prepare(
      `INSERT INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("web", "s1", "user", "hello", 1, "client_message_id:p1;prompt_meta:agent=claude");
    seedDb.exec("DROP INDEX IF EXISTS idx_history_entries_client_message_id");
    seedDb.exec("UPDATE schema_version SET version = 3 WHERE id = 1");

    resetStateDatabaseForTests();

    const db = getStateDatabase();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const info = insert.run("web", "s1", "user", "duplicate", 2, "client_message_id:p1;prompt_meta:agent=codex");
    const rows = db
      .prepare(
        `SELECT text, kind
         FROM history_entries
         WHERE namespace = ? AND session_id = ?
         ORDER BY id ASC`,
      )
      .all("web", "s1") as Array<{ text: string; kind: string }>;

    assert.strictEqual(info.changes, 0);
    assert.deepStrictEqual(rows, [
      { text: "hello", kind: "client_message_id:p1;prompt_meta:agent=claude" },
    ]);
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

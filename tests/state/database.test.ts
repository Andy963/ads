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

  it("keeps the full reasoning effort spectrum for seeded models during migrations", () => {
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

  it("sanitizes invalid reasoning efforts in model configs during migration", () => {
    const seedDb = getStateDatabase();
    const insert = seedDb.prepare(`
      INSERT INTO model_configs
        (id, model_id, display_name, provider, is_enabled, is_default, config_json, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?)
    `);
    const now = Date.now();
    insert.run(
      "model-test-invalid",
      "test-invalid",
      "Invalid",
      "test",
      JSON.stringify({ reasoningEfforts: ["bogus", "extreme"], defaultReasoningEffort: "xhigh", reasoningEffort: "bogus" }),
      now,
    );
    insert.run(
      "model-test-mixed",
      "test-mixed",
      "Mixed",
      "test",
      JSON.stringify({ reasoningEfforts: ["high", "xhigh", "bogus"], defaultReasoningEffort: "xhigh", reasoningEffort: "max" }),
      now,
    );
    insert.run("model-test-empty", "test-empty", "Empty", "test", JSON.stringify({ reasoningEfforts: [] }), now);
    insert.run(
      "model-test-unconfigured",
      "test-unconfigured",
      "Unconfigured",
      "test",
      JSON.stringify({ allowedAgents: ["codex"] }),
      now,
    );
    insert.run(
      "model-test-valid",
      "test-valid",
      "Valid",
      "test",
      JSON.stringify({ reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" }),
      now,
    );
    seedDb.exec("UPDATE schema_version SET version = 14 WHERE id = 1");

    resetStateDatabaseForTests();

    const db = getStateDatabase();
    const rows = db
      .prepare(
        `SELECT model_id, config_json
         FROM model_configs
         WHERE model_id LIKE 'test-%'
         ORDER BY model_id`,
      )
      .all() as Array<{ model_id: string; config_json: string }>;

    assert.deepStrictEqual(
      rows.map((row) => {
        const config = JSON.parse(row.config_json) as { reasoningEfforts: string[]; defaultReasoningEffort?: string; reasoningEffort?: string };
        return {
          modelId: row.model_id,
          reasoningEfforts: config.reasoningEfforts,
          defaultReasoningEffort: config.defaultReasoningEffort,
          reasoningEffort: config.reasoningEffort,
        };
      }),
      [
        { modelId: "test-empty", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffort: undefined },
        { modelId: "test-invalid", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffort: undefined },
        { modelId: "test-mixed", reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "xhigh", reasoningEffort: "max" },
        { modelId: "test-unconfigured", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffort: undefined },
        { modelId: "test-valid", reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", reasoningEffort: undefined },
      ],
    );
  });

  it("seeds gpt-5.6-luna with the full reasoning effort spectrum during migrations", () => {
    const seedDb = getStateDatabase();
    seedDb.exec("UPDATE schema_version SET version = 15 WHERE id = 1");
    seedDb.prepare("DELETE FROM model_configs WHERE model_id = 'gpt-5.6-luna'").run();

    resetStateDatabaseForTests();

    const db = getStateDatabase();
    const rows = db
      .prepare("SELECT config_json FROM model_configs WHERE model_id = 'gpt-5.6-luna'")
      .all() as Array<{ config_json: string }>;
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(JSON.parse(rows[0]!.config_json), {
      allowedAgents: ["codex"],
      reasoningEfforts: ["high", "xhigh", "max"],
      defaultReasoningEffort: "max",
    });
  });

  it("restores a wiped gpt-5.6-luna reasoning config during migrations", () => {
    const seedDb = getStateDatabase();
    seedDb
      .prepare("UPDATE model_configs SET config_json = ? WHERE model_id = 'gpt-5.6-luna'")
      .run(JSON.stringify({ allowedAgents: ["codex"], reasoningEfforts: ["high"], defaultReasoningEffort: "high" }));
    seedDb.exec("UPDATE schema_version SET version = 15 WHERE id = 1");

    resetStateDatabaseForTests();

    const db = getStateDatabase();
    const rows = db
      .prepare("SELECT config_json FROM model_configs WHERE model_id = 'gpt-5.6-luna'")
      .all() as Array<{ config_json: string }>;
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(JSON.parse(rows[0]!.config_json), {
      allowedAgents: ["codex"],
      reasoningEfforts: ["high", "xhigh", "max"],
      defaultReasoningEffort: "max",
    });
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

  it("should create action_jobs, role_profiles, and role_settings_history tables with seed profiles", () => {
    const db = getStateDatabase();

    const actionJobCols = (db.prepare("PRAGMA table_info(action_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(actionJobCols.includes("id"));
    assert.ok(actionJobCols.includes("project_id"));
    assert.ok(actionJobCols.includes("job_kind"));
    assert.ok(actionJobCols.includes("issue_id"));
    assert.ok(actionJobCols.includes("issue_title"));
    assert.ok(actionJobCols.includes("status"));
    assert.ok(actionJobCols.includes("reviewer_profile_ids_json"));
    assert.ok(actionJobCols.includes("rework_count"));

    const roleProfileCols = (db.prepare("PRAGMA table_info(role_profiles)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(roleProfileCols.includes("id"));
    assert.ok(roleProfileCols.includes("role"));
    assert.ok(roleProfileCols.includes("name"));
    assert.ok(roleProfileCols.includes("model_id"));
    assert.ok(roleProfileCols.includes("reasoning_effort"));
    assert.ok(roleProfileCols.includes("system_prompt"));
    assert.ok(roleProfileCols.includes("is_default"));

    const historyCols = (db.prepare("PRAGMA table_info(role_settings_history)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(historyCols.includes("role"));
    assert.ok(historyCols.includes("version"));
    assert.ok(historyCols.includes("model_id"));

    const profiles = db.prepare("SELECT role, name, is_default FROM role_profiles ORDER BY role ASC").all() as Array<{
      role: string;
      name: string;
      is_default: number;
    }>;
    assert.strictEqual(profiles.length, 3);
    assert.deepStrictEqual(
      profiles.map((p) => ({ role: p.role, is_default: p.is_default })),
      [
        { role: "acopilot", is_default: 1 },
        { role: "developer", is_default: 1 },
        { role: "reviewer", is_default: 1 },
      ],
    );
  });
});

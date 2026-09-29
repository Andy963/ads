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
import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";
import {
  createActionJob,
  getActionJobs,
  getActionJobById,
  updateActionJobStatus,
  deleteActionJobsByProject,
} from "../../server/state/actionJobStore.js";
import { createLanePromptStore } from "../../server/state/lanePromptStore.js";
import {
  getRoleProfiles,
  getDefaultRoleProfile,
  saveRoleProfile,
} from "../../server/state/roleProfileStore.js";
import { deleteWebProject } from "../../server/web/projects/store.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";
import { HistoryStore } from "../../server/utils/historyStore.js";

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

  it("should create action_jobs and role_profiles tables with seed profiles", () => {
    const db = getStateDatabase();

    const actionJobCols = (db.prepare("PRAGMA table_info(action_jobs)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(actionJobCols.includes("id"));
    assert.ok(actionJobCols.includes("project_id"));
    assert.ok(actionJobCols.includes("job_kind"));
    assert.ok(actionJobCols.includes("issue_id"));
    assert.ok(actionJobCols.includes("issue_title"));
    assert.ok(actionJobCols.includes("issue_snapshot_json"));
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

    const historyTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_settings_history'")
      .get();
    assert.strictEqual(historyTable, undefined);

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

  describe("state/actionJobStore", () => {
    it("creates, queries, and updates action jobs", () => {
      const db = getStateDatabase();
      const job = createActionJob(db, {
        id: "job-100-277-abcd",
        project_id: "/home/andy/repos/ads",
        issue_id: 277,
        issue_title: "Acopilot & Actions refactor",
        issue_snapshot: {
          title: "Acopilot & Actions refactor",
          description: "Complete immutable contract",
          acceptanceCriteria: ["Reviewer is isolated"],
          adrs: [{ id: "ADR 0020", title: "Reviewer context", decision: "Use a fresh session" }],
        },
        status: "queued",
        branch: "codex/issue-277",
      });

      assert.strictEqual(job.id, "job-100-277-abcd");
      assert.strictEqual(job.status, "queued");
      assert.strictEqual(job.rework_count, 0);

      const retrieved = getActionJobById(db, "job-100-277-abcd");
      assert.ok(retrieved);
      assert.strictEqual(retrieved.issue_id, 277);
      assert.deepStrictEqual(JSON.parse(retrieved.issue_snapshot_json), {
        title: "Acopilot & Actions refactor",
        description: "Complete immutable contract",
        acceptanceCriteria: ["Reviewer is isolated"],
        adrs: [{ id: "ADR 0020", title: "Reviewer context", decision: "Use a fresh session" }],
      });

      updateActionJobStatus(db, "job-100-277-abcd", "running", {
        current_step: "Implementing schema migrations",
        rework_count: 1,
      });

      const updated = getActionJobById(db, "job-100-277-abcd");
      assert.ok(updated);
      assert.strictEqual(updated.status, "running");
      assert.strictEqual(updated.current_step, "Implementing schema migrations");
      assert.strictEqual(updated.rework_count, 1);

      const list = getActionJobs(db, "/home/andy/repos/ads");
      assert.strictEqual(list.length, 1);

      createActionJob(db, {
        id: "job-standalone-del",
        project_id: "/home/andy/repos/standalone",
        issue_title: "Standalone task",
      });
      const deleted = deleteActionJobsByProject(db, "/home/andy/repos/standalone");
      assert.strictEqual(deleted, 1);
    });

    it("cascade deletes action_jobs when project is deleted", () => {
      const db = getStateDatabase();
      ensureWebAuthTables(db);
      ensureWebProjectTables(db);
      db.prepare("INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "u1",
        "user1",
        "hash",
        1,
        1,
      );
      db.prepare("INSERT OR IGNORE INTO web_projects (user_id, project_id, workspace_root, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        "u1",
        "proj-to-delete",
        "/tmp/proj",
        "Test Project",
        1,
        1,
      );

      createActionJob(db, {
        id: "job-del-1",
        project_id: "proj-to-delete",
        issue_title: "Task 1",
      });

      assert.strictEqual(getActionJobs(db, "proj-to-delete").length, 1);

      deleteWebProject(db, "u1", "proj-to-delete");

      assert.strictEqual(getActionJobs(db, "proj-to-delete").length, 0);
    });
  });

  describe("state/lanePromptStore", () => {
    let laneDb: DatabaseType | null = null;

    afterEach(() => {
      laneDb?.close();
      laneDb = null;
    });

    it("seeds both lane baselines and exposes the active versions", () => {
      laneDb = new DatabaseConstructor(":memory:");
      const store = createLanePromptStore(laneDb);

      const snapshots = store.listLanePrompts();
      assert.deepEqual(snapshots.map((snapshot) => snapshot.lane), ["acopilot", "actions"]);
      for (const snapshot of snapshots) {
        assert.equal(snapshot.current.version, 1);
        assert.equal(snapshot.current.isBase, true);
        assert.equal(snapshot.current.prompt.length > 0, true);
        assert.deepEqual(snapshot.versions.map((version) => version.version), [1]);
      }
    });

    it("appends versions and reset points to the immutable base version", () => {
      laneDb = new DatabaseConstructor(":memory:");
      const store = createLanePromptStore(laneDb);

      const saved = store.setLanePrompt("advisor", "Custom advisor prompt", 1000);
      assert.equal(saved.current.version, 2);
      assert.equal(saved.current.prompt, "Custom advisor prompt");
      assert.equal(saved.base.version, 1);
      assert.equal(saved.versions.length, 2);
      assert.equal(saved.updatedAt, 1000);

      const second = store.setLanePrompt("advisor", "Second advisor prompt", 2000);
      assert.equal(second.current.version, 3);
      assert.deepEqual(second.versions.map((version) => version.version), [3, 2, 1]);

      const reset = store.resetLanePrompt("advisor");
      assert.equal(reset.current.version, 1);
      assert.equal(reset.current.prompt, reset.base.prompt);
      assert.equal(reset.versions.length, 3);
    });

    it("rejects invalid lanes and empty prompts", () => {
      laneDb = new DatabaseConstructor(":memory:");
      const store = createLanePromptStore(laneDb);

      assert.throws(() => store.getLanePrompt("telegram" as never), /Unknown lane/);
      assert.throws(() => store.setLanePrompt("worker", "   "), /Prompt must not be empty/);
    });
  });

  describe("state/roleProfileStore", () => {
    it("retrieves seeded default role profiles", () => {
      const db = getStateDatabase();
      const allProfiles = getRoleProfiles(db);
      assert.ok(allProfiles.length >= 3);

      const acopilot = getDefaultRoleProfile(db, "acopilot");
      const developer = getDefaultRoleProfile(db, "developer");
      const reviewer = getDefaultRoleProfile(db, "reviewer");

      assert.ok(acopilot);
      assert.strictEqual(acopilot.role, "acopilot");
      assert.strictEqual(acopilot.is_default, 1);

      assert.ok(developer);
      assert.strictEqual(developer.role, "developer");
      assert.strictEqual(developer.is_default, 1);

      assert.ok(reviewer);
      assert.strictEqual(reviewer.role, "reviewer");
      assert.strictEqual(reviewer.is_default, 1);
    });

    it("keeps the Developer and Reviewer roles in separate, independently-defaulted profiles", () => {
      const db = getStateDatabase();

      // The role_profiles vocabulary holds a lane-level `acopilot` profile
      // alongside the two Actions roles, so a role filter must select exactly
      // one role and never bleed into another.
      for (const role of ["acopilot", "developer", "reviewer"] as const) {
        const rows = getRoleProfiles(db, role);
        assert.ok(rows.length > 0, `expected at least one ${role} profile`);
        assert.ok(
          rows.every((row) => row.role === role),
          `role filter ${role} returned a foreign role: ${rows.map((r) => r.role).join(",")}`,
        );
      }

      const developerDefault = getDefaultRoleProfile(db, "developer");
      const reviewerDefault = getDefaultRoleProfile(db, "reviewer");
      assert.ok(developerDefault && reviewerDefault);
      assert.notStrictEqual(developerDefault.id, reviewerDefault.id);
      assert.notStrictEqual(developerDefault.system_prompt, reviewerDefault.system_prompt);

      // Promoting a Developer default must not clear the Reviewer default: the
      // reset is scoped by role, which is what keeps the detached Reviewer
      // context from being merged into the Developer one.
      const promoted = saveRoleProfile(db, {
        id: "profile-developer-alt",
        role: "developer",
        name: "Developer Alternate",
        model_id: "gpt-5.6",
        system_prompt: "Developer alternate prompt",
        is_default: true,
      });
      assert.strictEqual(promoted.role, "developer");

      assert.strictEqual(getDefaultRoleProfile(db, "developer")?.id, "profile-developer-alt");

      // Assert the is_default flag itself rather than the returned id:
      // getDefaultRoleProfile falls back to any row for the role when no default
      // is flagged, so comparing ids would pass even if the promotion had
      // cleared every other role's default.
      assert.strictEqual(
        getRoleProfiles(db, "reviewer").filter((row) => row.is_default === 1).length,
        1,
        "the Reviewer must keep exactly one flagged default after a Developer promotion",
      );
      assert.strictEqual(
        getRoleProfiles(db, "acopilot").filter((row) => row.is_default === 1).length,
        1,
        "the Acopilot lane profile must keep exactly one flagged default after a Developer promotion",
      );
      assert.strictEqual(
        getRoleProfiles(db, "developer").filter((row) => row.is_default === 1).length,
        1,
        "promoting a Developer default must leave exactly one Developer default",
      );
    });

    it("saves a new role profile and updates default status", () => {
      const db = getStateDatabase();
      const newProfile = saveRoleProfile(db, {
        id: "profile-acopilot-gemini",
        role: "acopilot",
        name: "Acopilot Gemini Pro",
        model_id: "gemini-2.5-pro",
        reasoning_effort: "medium",
        system_prompt: "Custom system prompt for testing",
        is_default: true,
      });

      assert.strictEqual(newProfile.id, "profile-acopilot-gemini");
      assert.strictEqual(newProfile.version, 1);
      assert.strictEqual(newProfile.is_default, 1);

      const defaultProfile = getDefaultRoleProfile(db, "acopilot");
      assert.ok(defaultProfile);
      assert.strictEqual(defaultProfile.id, "profile-acopilot-gemini");
      assert.strictEqual(defaultProfile.model_id, "gemini-2.5-pro");
    });

    it("keeps repeated saves in role_profiles only, without growing any history table", () => {
      const db = getStateDatabase();
      for (let i = 0; i < 5; i += 1) {
        saveRoleProfile(db, {
          id: "profile-acopilot-repeat",
          role: "acopilot",
          name: "Acopilot Repeat",
          model_id: `model-${i}`,
          system_prompt: "Repeated save prompt",
        });
      }

      const saved = db
        .prepare("SELECT model_id, version FROM role_profiles WHERE id = ?")
        .get("profile-acopilot-repeat") as { model_id: string; version: number } | undefined;
      assert.ok(saved);
      assert.strictEqual(saved.model_id, "model-4");
      assert.strictEqual(saved.version, 5);

      const historyTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_settings_history'")
        .get();
      assert.strictEqual(historyTable, undefined);
    });

    it("drops a legacy role_settings_history table during migration while preserving role profiles", () => {
      const seedDb = getStateDatabase();
      seedDb.exec(`
        CREATE TABLE role_settings_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          version INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL DEFAULT 'high',
          system_prompt TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_role_settings_history_role ON role_settings_history(role, version DESC);
        INSERT INTO role_settings_history (role, version, model_id, reasoning_effort, system_prompt, created_at)
        VALUES ('acopilot', 1, 'legacy-model', 'high', 'legacy prompt', 1);
        UPDATE schema_version SET version = 29 WHERE id = 1;
      `);

      resetStateDatabaseForTests();

      const db = getStateDatabase();
      const historyTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_settings_history'")
        .get();
      assert.strictEqual(historyTable, undefined);
      const historyIndex = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_role_settings_history_role'")
        .get();
      assert.strictEqual(historyIndex, undefined);

      const profiles = getRoleProfiles(db);
      assert.strictEqual(profiles.length, 3);
    });
  });

  describe("shared prepared statements on state.db", () => {
    it("does not prepare a fresh thread/history statement set for each additional lane", () => {
      const db = getStateDatabase(dbPath);
      const originalPrepare = db.prepare.bind(db);
      let prepareCount = 0;

      (db as { prepare: typeof db.prepare }).prepare = ((...args: Parameters<typeof db.prepare>) => {
        prepareCount += 1;
        return originalPrepare(...args);
      }) as typeof db.prepare;

      try {
        const workerThreads = new ThreadStorage({ namespace: "web-worker", stateDbPath: dbPath });
        const workerHistory = new HistoryStore({ namespace: "web-worker", storagePath: dbPath });
        const afterWorkerLane = prepareCount;

        assert.ok(afterWorkerLane > 0);

        const advisorThreads = new ThreadStorage({ namespace: "web-advisor", stateDbPath: dbPath });
        const advisorHistory = new HistoryStore({ namespace: "web-advisor", storagePath: dbPath });
        const customThreads = new ThreadStorage({ namespace: "web-custom", stateDbPath: dbPath });
        const customHistory = new HistoryStore({ namespace: "web-custom", storagePath: dbPath });

        assert.equal(prepareCount, afterWorkerLane);

        workerThreads.setRecord(1, { threadId: "worker-thread", cwd: "/tmp/worker", agentThreads: { codex: "worker-thread" } });
        advisorThreads.setRecord(1, { threadId: "advisor-thread", cwd: "/tmp/advisor", agentThreads: { codex: "advisor-thread" } });
        customThreads.setRecord(1, { threadId: "custom-thread", cwd: "/tmp/custom", agentThreads: { codex: "custom-thread" } });

        workerHistory.add("session-1", { role: "user", text: "worker-entry", ts: 1 });
        advisorHistory.add("session-1", { role: "user", text: "advisor-entry", ts: 2 });
        customHistory.add("session-1", { role: "user", text: "custom-entry", ts: 3 });

        assert.equal(workerThreads.getRecord(1)?.threadId, "worker-thread");
        assert.equal(advisorThreads.getRecord(1)?.threadId, "advisor-thread");
        assert.equal(customThreads.getRecord(1)?.threadId, "custom-thread");

        assert.deepEqual(workerHistory.get("session-1").map((entry) => entry.text), ["worker-entry"]);
        assert.deepEqual(advisorHistory.get("session-1").map((entry) => entry.text), ["advisor-entry"]);
        assert.deepEqual(customHistory.get("session-1").map((entry) => entry.text), ["custom-entry"]);
      } finally {
        (db as { prepare: typeof db.prepare }).prepare = originalPrepare as typeof db.prepare;
      }
    });
  });
});

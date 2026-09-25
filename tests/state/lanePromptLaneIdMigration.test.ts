import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import DatabaseConstructor from "better-sqlite3";

import {
  getStateDatabase,
  resetStateDatabaseForTests,
} from "../../server/state/database.js";
import { createLanePromptStore } from "../../server/state/lanePromptStore.js";
import { stateSchemaMigrations } from "../../server/state/schemaMigrations.js";

const CANONICAL_LANE_MIGRATION_VERSION = 25;

/**
 * The exact DDL shipped before the terminology migration. Reproduced verbatim
 * so the migration runs against the schema it will actually meet in the field,
 * not a paraphrase of it.
 */
const LEGACY_DDL = `
  CREATE TABLE lane_system_prompt_versions (
    lane TEXT NOT NULL CHECK (lane IN ('advisor', 'worker')),
    version INTEGER NOT NULL CHECK (version >= 1),
    prompt TEXT NOT NULL,
    is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (lane, version)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_system_prompt_base
    ON lane_system_prompt_versions(lane)
    WHERE is_base = 1;

  CREATE TABLE lane_system_prompt_state (
    lane TEXT PRIMARY KEY CHECK (lane IN ('advisor', 'worker')),
    current_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (lane, current_version)
      REFERENCES lane_system_prompt_versions(lane, version)
  );
`;

function readTableSql(db: DatabaseConstructor.Database, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql?: string } | undefined;
  return row?.sql ?? "";
}

describe("state/lanePromptLaneIdMigration", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-lane-migration-"));
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

  /**
   * Build a database that looks like a real pre-migration installation:
   * legacy DDL, legacy lane rows, a customized prompt with version history, and
   * a schema version pinned just below the canonical-lane migration.
   */
  function seedLegacyDatabase(): void {
    const db = new DatabaseConstructor(dbPath);
    db.pragma("foreign_keys = ON");
    db.exec(LEGACY_DDL);

    const insertVersion = db.prepare(`
      INSERT INTO lane_system_prompt_versions (lane, version, prompt, is_base, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertVersion.run("advisor", 1, "Legacy advisor base prompt", 1, 1000);
    insertVersion.run("advisor", 2, "User customized advisor prompt", 0, 2000);
    insertVersion.run("worker", 1, "Legacy worker base prompt", 1, 1000);
    insertVersion.run("worker", 2, "User customized worker prompt", 0, 3000);

    const insertState = db.prepare(`
      INSERT INTO lane_system_prompt_state (lane, current_version, updated_at) VALUES (?, ?, ?)
    `);
    insertState.run("advisor", 2, 2000);
    insertState.run("worker", 2, 3000);

    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (id, version) VALUES (1, ${CANONICAL_LANE_MIGRATION_VERSION - 1});
    `);
    db.close();
  }

  it("rebuilds the CHECK constraints to canonical lane ids", () => {
    seedLegacyDatabase();
    getStateDatabase();

    const db = new DatabaseConstructor(dbPath, { readonly: true });
    try {
      const versionsSql = readTableSql(db, "lane_system_prompt_versions");
      const stateSql = readTableSql(db, "lane_system_prompt_state");
      assert.match(versionsSql, /'acopilot'/);
      assert.match(versionsSql, /'actions'/);
      assert.doesNotMatch(versionsSql, /'advisor'/);
      assert.match(stateSql, /'acopilot'/);
      assert.doesNotMatch(stateSql, /'worker'/);

      // The unique base-version index must survive the rebuild.
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all("lane_system_prompt_versions") as Array<{ name: string }>;
      assert.ok(
        indexes.some((index) => index.name === "idx_lane_system_prompt_base"),
        "base version index should be recreated",
      );
    } finally {
      db.close();
    }
  });

  it("remaps stored rows to canonical lanes and preserves prompt history", () => {
    seedLegacyDatabase();
    getStateDatabase();

    const db = new DatabaseConstructor(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT lane, version, prompt, is_base FROM lane_system_prompt_versions ORDER BY lane, version")
        .all() as Array<{ lane: string; version: number; prompt: string; is_base: number }>;

      assert.deepEqual(
        rows.map((row) => `${row.lane}:${row.version}`),
        ["acopilot:1", "acopilot:2", "actions:1", "actions:2"],
      );
      // Prompt text is data, not schema: it must survive verbatim, including
      // the user's customization.
      assert.equal(rows[1]?.prompt, "User customized advisor prompt");
      assert.equal(rows[3]?.prompt, "User customized worker prompt");
      assert.equal(rows[0]?.is_base, 1);

      const state = db
        .prepare("SELECT lane, current_version, updated_at FROM lane_system_prompt_state ORDER BY lane")
        .all() as Array<{ lane: string; current_version: number; updated_at: number }>;
      assert.deepEqual(
        state.map((row) => [row.lane, row.current_version, row.updated_at]),
        [
          ["acopilot", 2, 2000],
          ["actions", 2, 3000],
        ],
      );
    } finally {
      db.close();
    }
  });

  it("leaves no canonical or temporary tables behind", () => {
    seedLegacyDatabase();
    getStateDatabase();

    const db = new DatabaseConstructor(dbPath, { readonly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      assert.ok(!tables.includes("lane_system_prompt_versions__canonical"));
      assert.ok(!tables.includes("lane_system_prompt_state__canonical"));
      assert.ok(!tables.includes("lane_system_prompt_versions_legacy"));
    } finally {
      db.close();
    }
  });

  it("rejects legacy lane ids on write after the migration", () => {
    seedLegacyDatabase();
    const db = getStateDatabase();
    const store = createLanePromptStore(db);

    // Canonical writes succeed.
    const saved = store.setLanePrompt("acopilot", "Canonical write", 4000);
    assert.equal(saved.lane, "acopilot");

    // The rebuilt CHECK constraint is the last line of defence: a raw write
    // with a legacy id must now be refused by SQLite itself.
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO lane_system_prompt_versions (lane, version, prompt, is_base, created_at) VALUES (?, 9, 'x', 0, 1)",
          )
          .run("advisor"),
      /CHECK constraint failed/,
    );
  });

  it("resolves legacy ids to canonical lanes on read", () => {
    seedLegacyDatabase();
    const db = getStateDatabase();
    const store = createLanePromptStore(db);

    const fromLegacy = store.getLanePrompt("advisor" as never);
    assert.equal(fromLegacy.lane, "acopilot");
    assert.equal(fromLegacy.current.prompt, "User customized advisor prompt");

    const worker = store.getLanePrompt("worker" as never);
    assert.equal(worker.lane, "actions");

    // planner was a historical alias for the same lane.
    const planner = store.getLanePrompt("planner" as never);
    assert.equal(planner.lane, "acopilot");
  });

  it("is idempotent when run against an already canonical database", () => {
    seedLegacyDatabase();
    getStateDatabase();

    const migration = stateSchemaMigrations.find(
      (entry) => entry.version === CANONICAL_LANE_MIGRATION_VERSION,
    );
    assert.ok(migration, "canonical lane migration should be registered");

    const db = new DatabaseConstructor(dbPath);
    try {
      // Re-running must be a no-op rather than a destructive second rebuild.
      const before = db
        .prepare("SELECT lane, version, prompt FROM lane_system_prompt_versions ORDER BY lane, version")
        .all();
      migration.up(db);
      migration.up(db);
      const after = db
        .prepare("SELECT lane, version, prompt FROM lane_system_prompt_versions ORDER BY lane, version")
        .all();
      assert.deepEqual(after, before);
    } finally {
      db.close();
    }
  });

  it("repairs an orphaned legacy state table when the versions table is gone", () => {
    // Half-migrated / damaged schema: the state table survived but its parent
    // did not. Leaving the legacy CHECK in place would make the canonical
    // seeding in ensureLanePromptTables fail, so the store could never open.
    const db = new DatabaseConstructor(dbPath);
    db.exec(`
      CREATE TABLE lane_system_prompt_state (
        lane TEXT PRIMARY KEY CHECK (lane IN ('advisor', 'worker')),
        current_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO lane_system_prompt_state (lane, current_version, updated_at) VALUES ('advisor', 2, 2000);
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (id, version) VALUES (1, ${CANONICAL_LANE_MIGRATION_VERSION - 1});
    `);
    db.close();

    const migrated = getStateDatabase();
    const ddl = readTableSql(migrated, "lane_system_prompt_state");
    assert.doesNotMatch(ddl, /'advisor'/, "legacy CHECK must not survive");

    // The store must open and seed cleanly afterwards.
    const store = createLanePromptStore(migrated);
    assert.deepEqual(store.listLanePrompts().map((entry) => entry.lane), ["acopilot", "actions"]);
  });

  it("rebuilds only the state table when the versions table is already canonical", () => {
    const db = new DatabaseConstructor(dbPath);
    // Build the half-migrated state with FK enforcement off: a legacy `advisor`
    // state row cannot satisfy a foreign key against canonical versions, which
    // is exactly what makes this state damaged rather than merely unusual.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE lane_system_prompt_versions (
        lane TEXT NOT NULL CHECK (lane IN ('acopilot', 'actions')),
        version INTEGER NOT NULL CHECK (version >= 1),
        prompt TEXT NOT NULL,
        is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (lane, version)
      );
      CREATE UNIQUE INDEX idx_lane_system_prompt_base
        ON lane_system_prompt_versions(lane) WHERE is_base = 1;
      CREATE TABLE lane_system_prompt_state (
        lane TEXT PRIMARY KEY CHECK (lane IN ('advisor', 'worker')),
        current_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (lane, current_version) REFERENCES lane_system_prompt_versions(lane, version)
      );
      INSERT INTO lane_system_prompt_versions VALUES ('acopilot', 1, 'Canonical base', 1, 1000);
      INSERT INTO lane_system_prompt_versions VALUES ('acopilot', 2, 'Custom', 0, 2000);
      INSERT INTO lane_system_prompt_state VALUES ('advisor', 2, 2000);
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (id, version) VALUES (1, ${CANONICAL_LANE_MIGRATION_VERSION - 1});
    `);
    db.pragma("foreign_keys = ON");
    db.close();

    const migrated = getStateDatabase();
    const stateDdl = readTableSql(migrated, "lane_system_prompt_state");
    assert.match(stateDdl, /'acopilot'/);
    assert.doesNotMatch(stateDdl, /'advisor'/);

    // The versions table must be left exactly as it was, prompt data intact.
    const rows = migrated
      .prepare("SELECT lane, version, prompt FROM lane_system_prompt_versions ORDER BY version")
      .all() as Array<{ lane: string; version: number; prompt: string }>;
    assert.deepEqual(rows, [
      { lane: "acopilot", version: 1, prompt: "Canonical base" },
      { lane: "acopilot", version: 2, prompt: "Custom" },
    ]);

    const state = migrated.prepare("SELECT lane, current_version FROM lane_system_prompt_state").all();
    assert.deepEqual(state, [{ lane: "acopilot", current_version: 2 }]);
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
  });

  it("detects a legacy CHECK even when the DDL mentions acopilot elsewhere", () => {
    // Regression: detection used to sniff the whole DDL for the literal
    // 'acopilot'. This legacy table carries exactly that string in an unrelated
    // column default, so the old check would have declared it canonical, left
    // the legacy CHECK in place, and left the store unable to open. The default
    // value is intentionally a quoted literal, which is what the old substring
    // test matched on.
    const db = new DatabaseConstructor(dbPath);
    db.exec(`
      CREATE TABLE lane_system_prompt_versions (
        lane TEXT NOT NULL CHECK (lane IN ('advisor', 'worker')),
        version INTEGER NOT NULL CHECK (version >= 1),
        prompt TEXT NOT NULL,
        is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
        created_at INTEGER NOT NULL,
        note TEXT DEFAULT 'acopilot',
        PRIMARY KEY (lane, version)
      );
      CREATE UNIQUE INDEX idx_lane_system_prompt_base
        ON lane_system_prompt_versions(lane) WHERE is_base = 1;
      CREATE TABLE lane_system_prompt_state (
        lane TEXT PRIMARY KEY CHECK (lane IN ('advisor', 'worker')),
        current_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (lane, current_version) REFERENCES lane_system_prompt_versions(lane, version)
      );
      INSERT INTO lane_system_prompt_versions (lane, version, prompt, is_base, created_at)
        VALUES ('advisor', 1, 'Legacy base', 1, 1000);
      INSERT INTO lane_system_prompt_state VALUES ('advisor', 1, 1000);
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (id, version) VALUES (1, ${CANONICAL_LANE_MIGRATION_VERSION - 1});
    `);
    db.close();

    const migrated = getStateDatabase();
    const ddl = readTableSql(migrated, "lane_system_prompt_versions");
    assert.doesNotMatch(ddl, /'advisor'/, "legacy CHECK must not survive");
    assert.match(ddl, /'acopilot'/);
  });

  it("aborts loudly when the copied state would dangle", () => {
    // A state row pointing at a version that does not exist cannot be repaired
    // by remapping. Failing the migration is deliberate: it rolls back and stops
    // startup rather than leaving a store that silently serves the wrong
    // prompt version.
    const db = new DatabaseConstructor(dbPath);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE lane_system_prompt_versions (
        lane TEXT NOT NULL CHECK (lane IN ('advisor', 'worker')),
        version INTEGER NOT NULL CHECK (version >= 1),
        prompt TEXT NOT NULL,
        is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (lane, version)
      );
      CREATE UNIQUE INDEX idx_lane_system_prompt_base
        ON lane_system_prompt_versions(lane) WHERE is_base = 1;
      CREATE TABLE lane_system_prompt_state (
        lane TEXT PRIMARY KEY CHECK (lane IN ('advisor', 'worker')),
        current_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (lane, current_version) REFERENCES lane_system_prompt_versions(lane, version)
      );
      INSERT INTO lane_system_prompt_versions (lane, version, prompt, is_base, created_at)
        VALUES ('advisor', 1, 'Legacy base', 1, 1000);
      INSERT INTO lane_system_prompt_state VALUES ('advisor', 7, 1000);
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (id, version) VALUES (1, ${CANONICAL_LANE_MIGRATION_VERSION - 1});
    `);
    db.close();

    assert.throws(() => getStateDatabase(), /dangling reference|State migration 25/);
  });

  it("is a no-op on a database where the tables were never created", () => {
    const db = new DatabaseConstructor(":memory:");
    try {
      const migration = stateSchemaMigrations.find(
        (entry) => entry.version === CANONICAL_LANE_MIGRATION_VERSION,
      );
      assert.ok(migration);
      assert.doesNotThrow(() => migration.up(db));
    } finally {
      db.close();
    }
  });
});

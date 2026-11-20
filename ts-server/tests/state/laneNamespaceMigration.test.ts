import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DatabaseConstructor from "better-sqlite3";

import {
  getStateDatabase,
  getStateDatabaseInfo,
  resetStateDatabaseForTests,
} from "../../server/state/database.js";
import { stateSchemaMigrations } from "../../server/state/schemaMigrations.js";

const LANE_NAMESPACE_MIGRATION_VERSION = 26;

/**
 * The lane-scoped DDL as it exists at schema version 25. The migration only
 * rewrites rows, so the tests reproduce the shipped table shapes rather than a
 * simplified stand-in.
 */
const LANE_TABLES_DDL = `
  CREATE TABLE thread_state (
    namespace TEXT NOT NULL,
    user_hash TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    cwd TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, user_hash)
  );

  CREATE TABLE history_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT
  );

  CREATE UNIQUE INDEX idx_history_entries_client_message_id
    ON history_entries(
      namespace,
      session_id,
      substr(kind, length('client_message_id:') + 1, instr(kind || ';', ';') - length('client_message_id:') - 1)
    )
    WHERE kind LIKE 'client_message_id:%';

  CREATE TABLE history_session_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    provider_session_id TEXT NOT NULL,
    cwd TEXT,
    locator_json TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(namespace, session_id, agent_id, provider_session_id)
  );

  CREATE TABLE sync_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    lane_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL,
    ts INTEGER NOT NULL,
    run_id TEXT
  );

  CREATE UNIQUE INDEX idx_sync_events_dedup
    ON sync_events(namespace, lane_key, event_type, event_id, revision)
    WHERE event_id IS NOT NULL;

  CREATE TABLE sync_lane_state (
    namespace TEXT NOT NULL,
    lane_key TEXT NOT NULL,
    trimmed_through_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(namespace, lane_key)
  );

  CREATE TABLE web_lane_generations (
    namespace TEXT NOT NULL,
    lane_key TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, lane_key)
  );
`;

function seedLegacyDatabase(dbPath: string, seed: (db: DatabaseConstructor.Database) => void): void {
  const db = new DatabaseConstructor(dbPath);
  try {
    db.exec(LANE_TABLES_DDL);
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (id, version) VALUES (1, ${LANE_NAMESPACE_MIGRATION_VERSION - 1});
    `);
    seed(db);
  } finally {
    db.close();
  }
}

function namespaces(db: DatabaseConstructor.Database, table: string): string[] {
  return (db.prepare(`SELECT DISTINCT namespace FROM ${table} ORDER BY namespace`).all() as Array<{ namespace: string }>)
    .map((row) => row.namespace);
}

describe("state/laneNamespaceMigration", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-lane-namespace-migration-"));
    dbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = dbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites every retired namespace and lane key onto the canonical ids", () => {
    seedLegacyDatabase(dbPath, (db) => {
      const addHistory = db.prepare(
        "INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES (?, ?, ?, ?, ?, ?)",
      );
      addHistory.run("web-planner", "user-1::proj-1::planner", "user", "planner turn", 1, null);
      addHistory.run("web-advisor", "user-1::proj-1::advisor", "user", "advisor turn", 2, null);
      addHistory.run(
        "web-planner",
        "user-1::proj-1::planner:generation:2",
        "user",
        "fenced turn",
        3,
        null,
      );
      addHistory.run("web-worker", "user-1::proj-1::main", "user", "actions turn", 4, null);

      db.prepare("INSERT INTO thread_state VALUES ('web-planner', 'hash-1', 'thread-1', '/ws', 100)").run();
      db.prepare("INSERT INTO thread_state VALUES ('web-worker', 'hash-2', 'thread-2', '/ws', 200)").run();
      db.prepare(
        "INSERT INTO history_session_links VALUES (NULL, 'web-advisor', 'user-1::proj-1::advisor', 'codex', 'provider-1', '/ws', NULL, 10, 20)",
      ).run();
      db.prepare(
        "INSERT INTO sync_events (namespace, lane_key, event_type, event_id, revision, payload, ts) VALUES ('web-planner', 'user-1::proj-1::planner', 'delta', 'evt-1', 1, '{}', 30)",
      ).run();
      db.prepare(
        "INSERT INTO sync_events (namespace, lane_key, event_type, event_id, revision, payload, ts) VALUES ('web-worker', 'user-1::proj-1::main', 'delta', NULL, 1, '{}', 31)",
      ).run();
      db.prepare("INSERT INTO sync_lane_state VALUES ('web-planner', 'user-1::proj-1::planner', 12)").run();
      db.prepare("INSERT INTO web_lane_generations VALUES ('web-advisor', 'user-1::proj-1::advisor', 3, 40)").run();
    });

    const db = getStateDatabase();
    // The seeded database must reach the newest schema version, whatever
    // migrations were appended after the lane namespace migration.
    assert.equal(getStateDatabaseInfo().schemaVersion, stateSchemaMigrations.length);

    for (const table of [
      "thread_state",
      "history_entries",
      "history_session_links",
      "sync_events",
      "sync_lane_state",
      "web_lane_generations",
    ]) {
      for (const namespace of namespaces(db, table)) {
        assert.ok(
          namespace === "web-acopilot" || namespace === "web-actions",
          `${table} still holds retired namespace ${namespace}`,
        );
      }
    }

    const history = db
      .prepare("SELECT session_id, text FROM history_entries ORDER BY ts")
      .all() as Array<{ session_id: string; text: string }>;
    assert.deepEqual(
      history.map((row) => [row.session_id, row.text]),
      [
        ["user-1::proj-1::acopilot", "planner turn"],
        ["user-1::proj-1::acopilot", "advisor turn"],
        ["user-1::proj-1::acopilot:generation:2", "fenced turn"],
        ["user-1::proj-1::main", "actions turn"],
      ],
    );

    const generations = db
      .prepare("SELECT namespace, lane_key, generation FROM web_lane_generations")
      .all() as Array<{ namespace: string; lane_key: string; generation: number }>;
    assert.deepEqual(generations, [
      { namespace: "web-acopilot", lane_key: "user-1::proj-1::acopilot", generation: 3 },
    ]);
  });

  it("keeps every conversation row instead of colliding on a folded key", () => {
    seedLegacyDatabase(dbPath, (db) => {
      const addHistory = db.prepare(
        "INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES (?, ?, ?, ?, ?, ?)",
      );
      addHistory.run("web-planner", "user-1::proj-1::planner", "user", "first", 1, "client_message_id:m1;");
      addHistory.run("web-planner", "user-1::proj-1::planner", "assistant", "second", 2, null);
      addHistory.run("web-planner", "user-1::proj-1::planner", "assistant", "third", 3, null);
      addHistory.run("web-worker", "user-1::proj-1::main", "user", "actions", 4, "client_message_id:m1;");
    });

    const db = getStateDatabase();
    const rows = db
      .prepare("SELECT namespace, session_id, text FROM history_entries ORDER BY ts")
      .all() as Array<{ namespace: string; session_id: string; text: string }>;
    assert.deepEqual(rows, [
      { namespace: "web-acopilot", session_id: "user-1::proj-1::acopilot", text: "first" },
      { namespace: "web-acopilot", session_id: "user-1::proj-1::acopilot", text: "second" },
      { namespace: "web-acopilot", session_id: "user-1::proj-1::acopilot", text: "third" },
      { namespace: "web-actions", session_id: "user-1::proj-1::main", text: "actions" },
    ]);
  });

  it("folds a retired row into an existing canonical row instead of failing", () => {
    seedLegacyDatabase(dbPath, (db) => {
      const addHistory = db.prepare(
        "INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES (?, ?, ?, ?, ?, ?)",
      );
      // Same client message id in both namespaces: the unique index covers it.
      addHistory.run("web-planner", "user-1::proj-1::planner", "user", "legacy", 1, "client_message_id:m1;");
      addHistory.run("web-acopilot", "user-1::proj-1::acopilot", "user", "canonical", 2, "client_message_id:m1;");

      db.prepare("INSERT INTO thread_state VALUES ('web-planner', 'hash-1', 'legacy-thread', '/ws', 100)").run();
      db.prepare("INSERT INTO thread_state VALUES ('web-acopilot', 'hash-1', 'canonical-thread', '/ws', 900)").run();

      db.prepare("INSERT INTO web_lane_generations VALUES ('web-planner', 'user-1::proj-1::planner', 5, 10)").run();
      db.prepare("INSERT INTO web_lane_generations VALUES ('web-acopilot', 'user-1::proj-1::acopilot', 2, 20)").run();
    });

    const db = getStateDatabase();
    const history = db.prepare("SELECT text FROM history_entries").all() as Array<{ text: string }>;
    assert.deepEqual(history, [{ text: "canonical" }]);

    const threads = db
      .prepare("SELECT thread_id, updated_at FROM thread_state")
      .all() as Array<{ thread_id: string; updated_at: number }>;
    assert.deepEqual(threads, [{ thread_id: "canonical-thread", updated_at: 900 }]);

    const generations = db
      .prepare("SELECT lane_key, generation FROM web_lane_generations")
      .all() as Array<{ lane_key: string; generation: number }>;
    assert.deepEqual(generations, [{ lane_key: "user-1::proj-1::acopilot", generation: 5 }]);
  });

  it("is a no-op on a database that already uses canonical ids", () => {
    seedLegacyDatabase(dbPath, (db) => {
      db.prepare(
        "INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES ('web-acopilot', 'user-1::proj-1::acopilot', 'user', 'hello', 1, NULL)",
      ).run();
    });

    const db = getStateDatabase();
    const rows = db
      .prepare("SELECT namespace, session_id, text FROM history_entries")
      .all() as Array<{ namespace: string; session_id: string; text: string }>;
    assert.deepEqual(rows, [
      { namespace: "web-acopilot", session_id: "user-1::proj-1::acopilot", text: "hello" },
    ]);
  });
});

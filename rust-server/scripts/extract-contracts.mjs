#!/usr/bin/env node
/**
 * Extract executable contracts from the TypeScript implementation.
 *
 * The generated SQL is the authoritative final DDL produced by running every
 * existing TypeScript migration against a fresh database. The route and frame
 * inventories are static scans; they are compatibility checklists, not a
 * replacement for black-box conformance tests.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stateSchemaMigrations } from "../../ts-server/server/state/schemaMigrations.ts";
import { migrations as workspaceMigrations } from "../../ts-server/server/storage/migrations.ts";
import { ensureWebAuthTables } from "../../ts-server/server/web/auth/schema.ts";
import { loadTsServerDependency } from "./lib/ts-server-dependencies.mjs";

const Database = loadTsServerDependency("better-sqlite3");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const contractsDir = path.join(root, "rust-server", "contracts");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-contract-"));
const rustStateContractMigrations = [
  (db) => {
    addColumnIfMissing(db, "action_jobs", "superseded_at", "INTEGER");
    addColumnIfMissing(db, "action_jobs", "superseded_by_job_id", "TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  auth_user_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  history_key TEXT NOT NULL,
  logical_history_key TEXT NOT NULL,
  lane_namespace TEXT NOT NULL,
  lane_generation INTEGER NOT NULL CHECK(lane_generation >= 1),
  workspace_root TEXT NOT NULL,
  from_lane TEXT NOT NULL,
  from_role TEXT NOT NULL,
  to_lane TEXT NOT NULL,
  to_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  issue_id INTEGER,
  issue_title TEXT NOT NULL DEFAULT '',
  issue_url TEXT,
  pr_number INTEGER,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'delivered', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  source_created_at INTEGER NOT NULL,
  transition_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  delivered_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_correlation
  ON agent_messages(auth_user_id, project_id, to_lane, kind, correlation_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_lane
  ON agent_messages(auth_user_id, project_id, to_lane, lane_generation, status, id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_review
  ON agent_messages(auth_user_id, project_id, kind, issue_id, pr_number, status, id);`);
  },
  (db) => addColumnIfMissing(db, "action_jobs", "requires_agent_handoff", "INTEGER NOT NULL DEFAULT 0"),
  (db) => addColumnIfMissing(db, "action_jobs", "acopilot_lane_generation", "INTEGER NOT NULL DEFAULT 1"),
  (db) => addColumnIfMissing(db, "action_jobs", "agent_handoff_ready", "INTEGER NOT NULL DEFAULT 0"),
  // These migrations change data or were included in the final table definition above.
  () => {},
  () => {},
  (db) => addColumnIfMissing(db, "action_jobs", "rework_declaration_json", "TEXT"),
  (db) => addColumnIfMissing(db, "action_jobs", "rework_root_job_id", "TEXT"),
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(relativePath, value) {
  const target = path.join(contractsDir, relativePath);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function applyMigrations(db, migrations, label) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0);
  `);

  for (const migration of migrations) {
    const transaction = db.transaction(() => {
      migration.up(db);
      db.prepare("UPDATE schema_version SET version = ?, updated_at = datetime('now') WHERE id = 1").run(
        migration.version,
      );
    });
    try {
      transaction();
    } catch (error) {
      throw new Error(`${label} migration ${migration.version} failed: ${error.message}`);
    }
  }
}

function applyRustStateContractMigrations(db) {
  for (const migration of rustStateContractMigrations) {
    migration(db);
  }
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(({ name }) => name));
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function dumpSchema(db, label, version) {
  const rows = db
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts_%'
       ORDER BY CASE type
         WHEN 'table' THEN 0
         WHEN 'index' THEN 1
         WHEN 'trigger' THEN 2
         WHEN 'view' THEN 3
         ELSE 4
       END, name`,
    )
    .all();

  const sourceDescription = label === "state"
    ? "TypeScript migrations and explicit Rust SQLite contract migrations."
    : "the TypeScript migrations.";
  const header = [
    `-- ADS ${label} SQLite contract.`,
    `-- Generated by rust-server/scripts/extract-contracts.mjs from ${sourceDescription}`,
    `-- schema_version: ${version}`,
    `-- source_commit: ${sourceCommit}`,
    "",
    "PRAGMA foreign_keys = ON;",
    "",
    "BEGIN;",
    "",
  ].join("\n");
  const body = rows
    .map((row) => `${String(row.sql).trim().replace(/;+$/, "")};`)
    .join("\n\n");
  const footer = "\n\nCOMMIT;\n";
  const content = `${header}${body}${footer}`;
  fs.writeFileSync(path.join(contractsDir, "sqlite", `${label}.sql`), content, "utf8");

  return {
    schema_version: version,
    tables: rows.filter((row) => row.type === "table").length,
    indexes: rows.filter((row) => row.type === "index").length,
    triggers: rows.filter((row) => row.type === "trigger").length,
    views: rows.filter((row) => row.type === "view").length,
  };
}

function dumpSeed(db, label) {
  const tables = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name <> 'schema_version'
         AND name NOT LIKE '%_fts%'
       ORDER BY name`,
    )
    .all();
  const rowsByTable = new Map(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const timestamps = [...new Set(
    [...rowsByTable.values()]
      .flat()
      .flatMap((row) => Object.values(row))
      .filter((value) => typeof value === "number" && Number.isInteger(value) && value >= 1_000_000_000_000),
  )].sort((left, right) => left - right);
  const timestampOrdinals = new Map(timestamps.map((value, index) => [value, index * 10]));
  const normalize = (value) => timestampOrdinals.get(value) ?? value;
  const literal = (value) => {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return String(normalize(value));
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
    return `'${String(value).replace(/'/g, "''")}'`;
  };

  const statements = [];
  for (const { name } of tables) {
    const rows = rowsByTable.get(name) ?? [];
    for (const row of rows) {
      const columns = Object.keys(row);
      statements.push(
        `INSERT OR IGNORE INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns
          .map((column) => literal(row[column]))
          .join(", ")});`,
      );
    }
  }

  const header = [
    `-- ADS ${label} seed contract.`,
    "-- Generated by rust-server/scripts/extract-contracts.mjs from a freshly migrated TypeScript database.",
    "-- Millisecond epoch timestamps are normalized to stable ordinals so the file stays deterministic.",
    `-- source_commit: ${sourceCommit}`,
    "",
    "BEGIN;",
    "",
  ].join("\n");
  const footer = statements.length > 0 ? "\nCOMMIT;\n" : "COMMIT;\n";
  fs.writeFileSync(
    path.join(contractsDir, "sqlite", `${label}-seed.sql`),
    `${header}${statements.join("\n")}${footer}`,
    "utf8",
  );
  return { tables: statements.length };
}

function buildPasswordVector() {
  const password = "ads-contract-password";
  const salt = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const N = 16384;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(password, salt, 32, { N, r, p });
  return {
    password,
    algorithm: "scrypt",
    N,
    r,
    p,
    salt_hex: salt.toString("hex"),
    hash_base64url: derived.toString("base64url"),
    encoded: `scrypt$N=${N}$r=${r}$p=${p}$salt=${salt.toString("base64url")}$hash=${derived.toString("base64url")}`,
  };
}

function scanHttpRoutes() {
  const routesDir = path.join(root, "ts-server", "server", "web", "server", "api", "routes");
  const files = fs.readdirSync(routesDir).filter((name) => name.endsWith(".ts")).sort();
  const routes = new Map();

  for (const file of files) {
    const absoluteFile = path.join(routesDir, file);
    const lines = fs.readFileSync(absoluteFile, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const pathMatches = [...line.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)];
      for (const match of pathMatches) {
        const candidate = match[1];
        if (
          candidate.endsWith(".js") ||
          candidate.startsWith("/api/routes/") ||
          candidate.includes("${") ||
          candidate.includes("encodeURIComponent")
        ) {
          continue;
        }

        const methodWindow = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join("\n");
        const methods = [...new Set([...methodWindow.matchAll(/req\.method\s*===\s*"([A-Z]+)"/g)].map((m) => m[1]))];
        const key = `${candidate}\u0000${methods.sort().join(",")}`;
        if (!routes.has(key)) {
          routes.set(key, {
            path: candidate,
            methods: methods.length > 0 ? methods : ["ANY"],
            source: path.relative(root, absoluteFile),
            line: index + 1,
          });
        }
      }
    }
  }

  return {
    source_commit: sourceCommit,
    note: "Static scan of route files. Method lists may be incomplete when a route dispatches in a helper.",
    route_count: routes.size,
    routes: [...routes.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function scanFrameTypes() {
  const clientPath = path.join(root, "client", "src", "api", "ws.ts");
  const serverWsDir = path.join(root, "ts-server", "server", "web", "server", "ws");
  const sources = [clientPath, ...fs.readdirSync(serverWsDir).filter((name) => name.endsWith(".ts")).map((name) => path.join(serverWsDir, name))];
  const types = new Set();

  for (const source of sources) {
    const content = fs.readFileSync(source, "utf8");
    for (const match of content.matchAll(/type:\s*"([a-z_]+)"/g)) {
      types.add(match[1]);
    }
  }

  return {
    source_commit: sourceCommit,
    note: "Static literal inventory. The WebSocket type field is extensible and this list is not exhaustive.",
    envelope: {
      type: "string",
      payload: "unknown (optional)",
      client_message_id: "string (optional)",
      chat_session_id: "string (optional)",
    },
    handshake: {
      path: "/ws",
      protocols: ["ads-v1", "ads-session.<session-id>", "ads-chat.<chat-session-id>"],
      query: ["afterSeq.<chat-session-id>", "laneGeneration.<chat-session-id>"],
    },
    known_type_literals: [...types].sort(),
  };
}

try {
  ensureDir(path.join(contractsDir, "sqlite"));
  ensureDir(path.join(contractsDir, "auth"));
  ensureDir(path.join(contractsDir, "http"));
  ensureDir(path.join(contractsDir, "ws"));

  const stateDb = new Database(path.join(tempDir, "state.db"));
  applyMigrations(stateDb, stateSchemaMigrations, "state");
  ensureWebAuthTables(stateDb);
  applyRustStateContractMigrations(stateDb);
  const rustStateContractMigrationCount = rustStateContractMigrations.length;
  const stateInfo = dumpSchema(
    stateDb,
    "state",
    stateSchemaMigrations.length + rustStateContractMigrationCount,
  );
  dumpSeed(stateDb, "state");
  stateDb.close();

  const workspaceDb = new Database(path.join(tempDir, "workspace.db"));
  applyMigrations(workspaceDb, workspaceMigrations, "workspace");
  const workspaceInfo = dumpSchema(workspaceDb, "workspace", workspaceMigrations.length);
  dumpSeed(workspaceDb, "workspace");
  workspaceDb.close();

  writeJson("sqlite/manifest.json", {
    source_commit: sourceCommit,
    state: stateInfo,
    workspace: workspaceInfo,
    state_migration_count: stateSchemaMigrations.length,
    rust_state_contract_migration_count: rustStateContractMigrationCount,
    workspace_migration_count: workspaceMigrations.length,
  });
  writeJson("auth/password-vector.json", buildPasswordVector());
  writeJson("http/routes.json", scanHttpRoutes());
  writeJson("ws/frames.json", scanFrameTypes());

  console.log(`[contracts] wrote SQLite, auth, HTTP, and WS contracts from ${sourceCommit}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

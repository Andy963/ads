import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getDatabase, resetDatabaseForTests } from "../../server/storage/database.js";

describe("migration v22: tasks goal_* columns", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-mig22-test-"));
    dbPath = path.join(tmpDir, "test.db");
    process.env.ADS_DATABASE_PATH = dbPath;
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

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

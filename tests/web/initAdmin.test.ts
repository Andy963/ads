import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase, resetStateDatabaseForTests } from "../../src/state/database.js";
import { initAdmin } from "../../src/web/auth/initAdmin.js";

describe("web/auth/initAdmin", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-init-admin-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should create admin once and refuse subsequent runs", () => {
    const first = initAdmin({ username: "admin", password: "pw", nowSeconds: 1700000000 });
    assert.equal(first.status, "created");

    const dbPath = process.env.ADS_STATE_DB_PATH as string;
    const db = getStateDatabase(dbPath);
    const count = db.prepare("SELECT COUNT(*) AS c FROM web_users").get() as { c: number };
    assert.equal(count.c, 1);

    const row = db
      .prepare("SELECT username, password_hash, created_at, updated_at FROM web_users LIMIT 1")
      .get() as {
      username: string;
      password_hash: string;
      created_at: number;
      updated_at: number;
    };
    assert.equal(row.username, "admin");
    assert.equal(row.created_at, 1700000000);
    assert.equal(row.updated_at, 1700000000);
    assert.ok(row.password_hash.startsWith("scrypt$"));

    const second = initAdmin({ username: "other", password: "pw2" });
    assert.equal(second.status, "already_initialized");
  });
});

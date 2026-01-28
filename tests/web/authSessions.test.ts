import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests, getStateDatabase } from "../../src/state/database.js";
import { initAdmin } from "../../src/web/auth/initAdmin.js";
import {
  createWebSession,
  hashSessionToken,
  lookupSessionByToken,
  revokeSessionByTokenHash,
} from "../../src/web/auth/sessions.js";

describe("web/auth/sessions", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-auth-sessions-"));
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

  it("should create and revoke sessions by token hash", () => {
    const admin = initAdmin({ username: "admin", password: "pw", nowSeconds: 1700000000 });
    assert.equal(admin.status, "created");

    const pepper = "pepper";
    const { token, session } = createWebSession({
      userId: admin.userId,
      nowSeconds: 1700000000,
      ttlSeconds: 60,
      pepper,
      lastSeenIp: "127.0.0.1",
      userAgent: "test",
    });

    assert.equal(session.token_hash, hashSessionToken(token, pepper));
    assert.notEqual(session.token_hash, token);

    const db = getStateDatabase(process.env.ADS_STATE_DB_PATH);
    const row = db.prepare("SELECT token_hash FROM web_sessions LIMIT 1").get() as { token_hash: string };
    assert.equal(row.token_hash, session.token_hash);

    const lookup = lookupSessionByToken({ token, pepper, nowSeconds: 1700000001, ttlSeconds: 60 });
    assert.equal(lookup.ok, true);
    if (lookup.ok) {
      assert.equal(lookup.user.id, admin.userId);
      assert.equal(lookup.user.username, "admin");
    }

    const revoked = revokeSessionByTokenHash({ tokenHash: session.token_hash, nowSeconds: 1700000002 });
    assert.equal(revoked, true);

    const lookup2 = lookupSessionByToken({ token, pepper, nowSeconds: 1700000003, ttlSeconds: 60 });
    assert.equal(lookup2.ok, false);
    if (!lookup2.ok) {
      assert.equal(lookup2.reason, "revoked");
    }
  });
});


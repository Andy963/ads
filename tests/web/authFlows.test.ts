import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests, getStateDatabase } from "../../server/state/database.js";
import { serializeCookie } from "../../server/web/auth/cookies.js";
import { initAdmin } from "../../server/web/auth/initAdmin.js";
import {
  createWebSession,
  hashSessionToken,
  lookupSessionByToken,
  resolveSessionSlidingEnabled,
  resolveSessionTtlSeconds,
  revokeSessionByTokenHash,
} from "../../server/web/auth/sessions.js";

describe("web/auth/cookies", () => {
  it("serializeCookie should include HttpOnly by default", () => {
    const header = serializeCookie("ads_session", "t", { sameSite: "Lax", maxAgeSeconds: 60 });
    assert.match(header, /^ads_session=t;/);
    assert.ok(header.includes("HttpOnly"));
    assert.ok(!header.includes("Secure"));
    assert.ok(header.includes("SameSite=Lax"));
    assert.ok(header.includes("Path=/"));
    assert.ok(header.includes("Max-Age=60"));
  });

  it("serializeCookie should include Secure only when requested", () => {
    const header = serializeCookie("ads_session", "t", { sameSite: "Lax", maxAgeSeconds: 60, secure: true });
    assert.ok(header.includes("Secure"));
  });
});

describe("web/auth state-backed flows", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-auth-flows-"));
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

  it("initAdmin: should create admin once and refuse subsequent runs", () => {
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

  it("sessions: should create and revoke sessions by token hash", () => {
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

  it("sessions: resolves session env config with safe defaults", () => {
    delete process.env.ADS_WEB_SESSION_TTL_SECONDS;
    delete process.env.ADS_WEB_SESSION_SLIDING;
    assert.equal(resolveSessionTtlSeconds(), 604800);
    assert.equal(resolveSessionSlidingEnabled(), false);

    process.env.ADS_WEB_SESSION_TTL_SECONDS = "30";
    assert.equal(resolveSessionTtlSeconds(), 60);

    process.env.ADS_WEB_SESSION_TTL_SECONDS = "120";
    assert.equal(resolveSessionTtlSeconds(), 120);

    process.env.ADS_WEB_SESSION_SLIDING = "TrUe";
    assert.equal(resolveSessionSlidingEnabled(), true);
    process.env.ADS_WEB_SESSION_SLIDING = "off";
    assert.equal(resolveSessionSlidingEnabled(), false);
    process.env.ADS_WEB_SESSION_SLIDING = "unknown";
    assert.equal(resolveSessionSlidingEnabled(), false);
  });
});

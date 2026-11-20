import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { resetStateDatabaseForTests, getStateDatabase } from "../../server/state/database.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { resolveCodexProviderInjection, CODEX_PROVIDER_API_KEY_ENV } from "../../server/codex/appServer/providerInjection.js";
import { serializeCookie } from "../../server/web/auth/cookies.js";
import { initAdmin } from "../../server/web/auth/initAdmin.js";
import { authenticateRequest } from "../../server/web/server/auth.js";
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

  it("connector authentication uses the primary Web user for provider credentials", () => {
    const admin = initAdmin({ username: "admin", password: "pw", nowSeconds: 1700000000 });
    assert.equal(admin.status, "created");
    process.env.ADS_CONNECTOR_TOKEN = "connector-token";
    delete process.env.ADS_CONNECTOR_USER_ID;

    const db = getStateDatabase(process.env.ADS_STATE_DB_PATH);
    createModelProviderStore(db).upsertProvider({
      id: "provider-openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      wireApi: "responses",
      isEnabled: true,
    });
    createGlobalModelConfigStore(db).upsertModelConfig({
      id: "model-1",
      modelId: "gpt-5.2",
      displayName: "GPT 5.2",
      provider: "openai",
      providerId: "provider-openrouter",
      isEnabled: true,
      isDefault: false,
    });
    createUpstreamCredentialStore(db).save(
      admin.userId,
      { baseUrl: "https://openrouter.ai/api/v1", provider: "provider-openrouter", apiKey: "admin-provider-key" },
      "provider-openrouter",
    );

    const auth = authenticateRequest(
      { headers: { authorization: "Bearer connector-token" } } as http.IncomingMessage,
      { sessionTtlSeconds: 60, sessionPepper: "pepper" },
    );
    assert.equal(auth.ok, true);
    if (!auth.ok) return;
    assert.equal(auth.userId, admin.userId);
    assert.equal(auth.username, "admin");
    assert.equal(auth.connector, true);

    const injection = resolveCodexProviderInjection({ db, owner: auth.userId, model: "gpt-5.2" });
    assert.equal(injection?.env[CODEX_PROVIDER_API_KEY_ENV], "admin-provider-key");
  });

  it("connector authentication honors an explicit credential owner override", () => {
    initAdmin({ username: "admin", password: "pw", nowSeconds: 1700000000 });
    process.env.ADS_CONNECTOR_TOKEN = "connector-token";
    process.env.ADS_CONNECTOR_USER_ID = "configured-owner";

    const auth = authenticateRequest(
      { headers: { authorization: "Bearer connector-token" } } as http.IncomingMessage,
      { sessionTtlSeconds: 60, sessionPepper: "pepper" },
    );
    assert.equal(auth.ok, true);
    if (!auth.ok) return;
    assert.equal(auth.userId, "configured-owner");
    assert.equal(auth.username, "configured-owner");
    assert.equal(auth.connector, true);
  });
});

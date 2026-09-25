import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSessionAgentAllowlist, SessionManager } from "../../server/sessions/sessionManager.js";
import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { closeAllStateDatabases, getStateDatabase } from "../../server/state/database.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";

function buildNativeTranscriptId(input: {
  owner: string;
  sessionKey: string;
  projectId: string;
  domain?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 2,
      owner: input.owner,
      sessionKey: input.sessionKey,
      projectId: input.projectId,
      domain: input.domain ?? "default",
      lane: "worker",
      lifecycle: "durable",
    }))
    .digest("hex");
}

describe("SessionManager agent allowlists", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses interactive allowlists for telegram and interactive web lanes", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("telegram"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-worker"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-advisor"), ["codex"]);
  });

  it("uses codex-only allowlists for scheduler surfaces", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("scheduler-runtime"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("scheduler-compiler"), ["codex"]);
  });

  it("honors compatibility env toggles when resolving allowlists", () => {
    process.env.ADS_CLAUDE_ENABLED = "0";

    assert.deepEqual(resolveSessionAgentAllowlist("telegram"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-worker"), ["codex"]);
  });

  it("keeps the configured allowlist on SessionManager instances", () => {
    const manager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      agentAllowlist: ["codex"],
      createSession: () =>
        ({
          send: async () => ({ response: "ok", usage: null, agentId: "codex" }),
          onEvent: () => () => {},
          getThreadId: () => null,
          reset: () => {},
          setModel: () => {},
          setWorkingDirectory: () => {},
          status: () => ({ ready: true, streaming: true }),
          getActiveAgentId: () => "codex",
          listAgents: () => [],
          switchAgent: () => {},
        }) as any,
    });

    try {
    assert.deepEqual(manager.getConfiguredAgentIds(), ["codex"]);
    } finally {
      manager.destroy();
    }
  });

  it("uses the app-server adapter for the codex agent by default", () => {
    const manager = new SessionManager(0, 0, "workspace-write");

    try {
      const session = manager.getOrCreate(123456, "/tmp/ads-codex-unified");
      const adapter = session.getAdapter("codex");

      assert(adapter instanceof CodexAppServerAdapter);
      assert.equal(adapter?.id, "codex");
      assert.equal(adapter?.preservesThreadOnModelChange, true);
    } finally {
      manager.destroy();
    }
  });

  it("selects the native adapter only when explicitly enabled", () => {
    const manager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      undefined,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
    );

    try {
      const session = manager.getOrCreate(123457, "/tmp/ads-native-runtime-session");
      const adapter = session.getAdapter("codex");

      assert(adapter instanceof NativeAgentAdapter);
      assert.equal(adapter?.id, "codex");
      assert.equal(adapter?.preservesThreadOnModelChange, true);
    } finally {
      manager.destroy();
    }
  });

  it("uses the authenticated owner when a native web session resolves credentials", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-owner-"));
    const dbPath = path.join(directory, "state.db");
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    credentials.save("auth-user-uuid", {
      baseUrl: "https://provider.test/v1",
      provider: "custom",
      apiKey: "profile-secret",
    }, "custom-profile");
    modelStore.upsertModelConfig({
      id: "model-custom",
      modelId: "custom-model",
      displayName: "Custom",
      provider: "custom",
      isEnabled: true,
      isDefault: false,
      configJson: { credentialProfile: "custom-profile" },
    });

    const manager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      undefined,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { stateDbPath: dbPath },
    );
    try {
      const session = manager.getOrCreate(123457, directory, true, { authUserId: "auth-user-uuid" });
      session.setModel("custom-model");
      session.setModelConfig({ credentialProfile: "custom-profile" });

      assert.equal(session.status().ready, true);
    } finally {
      manager.destroy();
      closeAllStateDatabases();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates durable Native transcripts by logical session", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-transcript-"));
    const dbPath = path.join(directory, "state.db");
    const owner = "auth-user-transcript";
    const projectId = "project-transcript";
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const firstUserId = 123458;
    const secondUserId = 123459;
    const firstTranscriptId = buildNativeTranscriptId({ owner, sessionKey: String(firstUserId), projectId });
    const secondTranscriptId = buildNativeTranscriptId({ owner, sessionKey: String(secondUserId), projectId });
    for (const [transcriptId, turnId, memory] of [
      [firstTranscriptId, "first-turn", "first memory"],
      [secondTranscriptId, "second-turn", "second memory"],
    ] as const) {
      store.beginTurn({
        transcriptId,
        turnId,
        messages: [{ role: "user", content: memory }],
        entries: [{ kind: "message", message: { role: "user", content: memory } }],
        provider: { provider: "test", model: "test-model" },
      });
      store.updateTurn({
        transcriptId,
        turnId,
        status: "completed",
        messages: [
          { role: "user", content: memory },
          { role: "assistant", content: `remembered ${memory}` },
        ],
        entries: [
          { kind: "message", message: { role: "user", content: memory } },
          { kind: "message", message: { role: "assistant", content: `remembered ${memory}` } },
        ],
        usage: null,
      });
    }

    const manager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      undefined,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { stateDbPath: dbPath, lane: "worker" },
    );
    try {
      const firstSession = manager.getOrCreate(firstUserId, directory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      const secondSession = manager.getOrCreate(secondUserId, directory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      assert(firstSession.getAdapter("codex") instanceof NativeAgentAdapter);
      assert(secondSession.getAdapter("codex") instanceof NativeAgentAdapter);
      assert.equal(manager.getContextRestoreMode(firstUserId), "thread_resumed");
      assert.equal(manager.getContextRestoreMode(secondUserId), "thread_resumed");
      assert.equal(manager.needsHistoryInjection(firstUserId), false);
      assert.equal(manager.needsHistoryInjection(secondUserId), false);

      manager.reset(firstUserId);
      assert.deepEqual(store.loadCompletedMessages(firstTranscriptId), []);
      assert.equal(store.loadCompletedMessages(secondTranscriptId).at(-1)?.content, "remembered second memory");

      manager.dropSession(secondUserId);
      manager.getOrCreate(secondUserId, directory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      assert.equal(manager.getContextRestoreMode(secondUserId), "thread_resumed");
      assert.equal(manager.needsHistoryInjection(secondUserId), false);
    } finally {
      manager.destroy();
      closeAllStateDatabases();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a Native transcript when the saved CWD is no longer compatible", () => {
    const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-cwd-a-"));
    const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-cwd-b-"));
    const dbPath = path.join(firstDirectory, "state.db");
    const owner = "auth-user-cwd-scope";
    const projectId = "project-cwd-scope";
    const userId = 123460;
    const transcriptId = buildNativeTranscriptId({ owner, sessionKey: String(userId), projectId, domain: "native-cwd-scope" });
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const threadStorage = new ThreadStorage({ stateDbPath: dbPath, namespace: "native-cwd-scope" });
    store.beginTurn({
      transcriptId,
      turnId: "old-turn",
      messages: [{ role: "user", content: "old project context" }],
      entries: [{ kind: "message", message: { role: "user", content: "old project context" } }],
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "old-turn",
      status: "completed",
      messages: [{ role: "user", content: "old project context" }],
      entries: [{ kind: "message", message: { role: "user", content: "old project context" } }],
      usage: null,
    });

    const manager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      threadStorage,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { stateDbPath: dbPath, lane: "worker" },
    );
    try {
      manager.getOrCreate(userId, firstDirectory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      assert.equal(manager.getContextRestoreMode(userId), "thread_resumed");
      manager.dropSession(userId);

      manager.getOrCreate(userId, secondDirectory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });

      assert.equal(manager.getContextRestoreMode(userId), "fresh");
      assert.equal(manager.needsHistoryInjection(userId), false);
      assert.deepEqual(store.loadCompletedMessages(transcriptId), []);
    } finally {
      manager.destroy();
      closeAllStateDatabases();
      fs.rmSync(firstDirectory, { recursive: true, force: true });
      fs.rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it("clears a durable Native transcript when reset arrives after disposal", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-reset-after-dispose-"));
    const dbPath = path.join(directory, "state.db");
    const owner = "auth-user-reset-after-dispose";
    const projectId = "project-reset-after-dispose";
    const userId = 123461;
    const transcriptId = buildNativeTranscriptId({ owner, sessionKey: String(userId), projectId, domain: "native-reset-after-dispose" });
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const threadStorage = new ThreadStorage({ stateDbPath: dbPath, namespace: "native-reset-after-dispose" });
    store.beginTurn({
      transcriptId,
      turnId: "old-turn",
      messages: [{ role: "user", content: "old context" }],
      entries: [{ kind: "message", message: { role: "user", content: "old context" } }],
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "old-turn",
      status: "completed",
      messages: [{ role: "user", content: "old context" }],
      entries: [{ kind: "message", message: { role: "user", content: "old context" } }],
      usage: null,
    });

    const manager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      threadStorage,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { stateDbPath: dbPath, lane: "worker" },
    );
    try {
      manager.getOrCreate(userId, directory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      assert.equal(threadStorage.getRecord(userId)?.nativeTranscriptId, transcriptId);
      manager.dropSession(userId);
      assert.equal(store.listTurns(transcriptId).length, 1);

      manager.reset(userId);
      assert.deepEqual(store.listTurns(transcriptId), []);
      assert.equal(threadStorage.getRecord(userId), undefined);
    } finally {
      manager.destroy();
      closeAllStateDatabases();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retargets the durable Native transcript when an active session changes CWD", () => {
    const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-active-cwd-a-"));
    const secondDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-active-cwd-b-"));
    const dbPath = path.join(firstDirectory, "state.db");
    const owner = "auth-user-active-cwd";
    const projectId = "project-active-cwd";
    const userId = 123462;
    const oldTranscriptId = buildNativeTranscriptId({ owner, sessionKey: String(userId), projectId, domain: "native-active-cwd" });
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const threadStorage = new ThreadStorage({ stateDbPath: dbPath, namespace: "native-active-cwd" });
    store.beginTurn({
      transcriptId: oldTranscriptId,
      turnId: "old-turn",
      messages: [{ role: "user", content: "old cwd" }],
      entries: [{ kind: "message", message: { role: "user", content: "old cwd" } }],
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId: oldTranscriptId,
      turnId: "old-turn",
      status: "completed",
      messages: [{ role: "user", content: "old cwd" }],
      entries: [{ kind: "message", message: { role: "user", content: "old cwd" } }],
      usage: null,
    });

    const manager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      threadStorage,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { stateDbPath: dbPath, lane: "worker" },
    );
    try {
      manager.getOrCreate(userId, firstDirectory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      manager.getOrCreate(userId, secondDirectory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });

      const nextTranscriptId = threadStorage.getRecord(userId)?.nativeTranscriptId;
      assert.ok(nextTranscriptId);
      assert.equal(nextTranscriptId, oldTranscriptId);
      assert.equal(
        nextTranscriptId,
        buildNativeTranscriptId({
          owner,
          sessionKey: String(userId),
          projectId,
          domain: "native-active-cwd",
          lane: "worker",
          lifecycle: "durable",
        }),
      );
      assert.deepEqual(store.loadCompletedMessages(oldTranscriptId), []);
      assert.equal(manager.getContextRestoreMode(userId), "fresh");
    } finally {
      manager.destroy();
      closeAllStateDatabases();
      fs.rmSync(firstDirectory, { recursive: true, force: true });
      fs.rmSync(secondDirectory, { recursive: true, force: true });
    }
  });
});

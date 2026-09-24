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

  it("restores a durable Native transcript without history injection", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-session-transcript-"));
    const dbPath = path.join(directory, "state.db");
    const owner = "auth-user-transcript";
    const projectId = "project-transcript";
    const transcriptId = createHash("sha256")
      .update(JSON.stringify({
        version: 1,
        owner,
        projectId,
        lane: "worker",
        lifecycle: "durable",
      }))
      .digest("hex");
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    store.beginTurn({
      transcriptId,
      turnId: "completed-turn",
      messages: [{ role: "user", content: "remember this" }],
      entries: [{ kind: "message", message: { role: "user", content: "remember this" } }],
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "completed-turn",
      status: "completed",
      messages: [
        { role: "user", content: "remember this" },
        { role: "assistant", content: "remembered" },
      ],
      entries: [
        { kind: "message", message: { role: "user", content: "remember this" } },
        { kind: "message", message: { role: "assistant", content: "remembered" } },
      ],
      usage: null,
    });

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
      const session = manager.getOrCreate(123458, directory, true, {
        authUserId: owner,
        projectId,
        lifecycle: "durable",
      });
      assert(session.getAdapter("codex") instanceof NativeAgentAdapter);
      assert.equal(manager.getContextRestoreMode(123458), "thread_resumed");
      assert.equal(manager.needsHistoryInjection(123458), false);
    } finally {
      manager.destroy();
      closeAllStateDatabases();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

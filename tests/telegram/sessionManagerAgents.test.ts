import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveSessionAgentAllowlist, SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";

describe("SessionManager agent allowlists", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses interactive allowlists for telegram and interactive web lanes", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("telegram"), ["codex", "claude"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-worker"), ["codex", "claude"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-planner"), ["codex", "claude"]);
  });

  it("allows Codex and Claude in the task queue", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("task-queue"), ["codex", "claude"]);
  });

  it("uses codex-only allowlists for scheduler surfaces", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("scheduler-runtime"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("scheduler-compiler"), ["codex"]);
  });

  it("honors compatibility env toggles when resolving allowlists", () => {
    process.env.ADS_CLAUDE_ENABLED = "0";

    assert.deepEqual(resolveSessionAgentAllowlist("telegram"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-worker"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("task-queue"), ["codex"]);
  });

  it("keeps the configured allowlist on SessionManager instances", () => {
    const manager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      agentAllowlist: ["codex", "claude"],
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
    assert.deepEqual(manager.getConfiguredAgentIds(), ["codex", "claude"]);
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
});

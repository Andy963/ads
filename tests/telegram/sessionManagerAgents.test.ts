import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveSessionAgentAllowlist, SessionManager } from "../../server/telegram/utils/sessionManager.js";

describe("SessionManager agent allowlists", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses interactive allowlists for telegram and interactive web lanes", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("telegram"), ["codex", "claude", "gemini"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-worker"), ["codex", "claude", "gemini"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-planner"), ["codex", "claude", "gemini"]);
  });

  it("uses codex-only allowlists for reviewer, task queue, and scheduler surfaces", () => {
    assert.deepEqual(resolveSessionAgentAllowlist("web-reviewer"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("task-queue"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("scheduler-runtime"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("scheduler-compiler"), ["codex"]);
  });

  it("honors compatibility env toggles when resolving allowlists", () => {
    process.env.ADS_CLAUDE_ENABLED = "0";
    process.env.ADS_GEMINI_ENABLED = "0";

    assert.deepEqual(resolveSessionAgentAllowlist("telegram"), ["codex"]);
    assert.deepEqual(resolveSessionAgentAllowlist("web-worker"), ["codex"]);
  });

  it("keeps the configured allowlist on SessionManager instances", () => {
    const manager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      agentAllowlist: ["codex", "gemini"],
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
      assert.deepEqual(manager.getConfiguredAgentIds(), ["codex", "gemini"]);
    } finally {
      manager.destroy();
    }
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { injectToolGuide } from "../../src/agents/tools.js";

describe("agents/toolGuide", () => {
  const originalEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    originalEnv.ENABLE_AGENT_FILE_TOOLS = process.env.ENABLE_AGENT_FILE_TOOLS;
    originalEnv.ENABLE_AGENT_APPLY_PATCH = process.env.ENABLE_AGENT_APPLY_PATCH;
    originalEnv.ENABLE_AGENT_EXEC_TOOL = process.env.ENABLE_AGENT_EXEC_TOOL;

    setEnv("ENABLE_AGENT_FILE_TOOLS", "1");
    setEnv("ENABLE_AGENT_APPLY_PATCH", "1");
    setEnv("ENABLE_AGENT_EXEC_TOOL", "1");
  });

  afterEach(() => {
    setEnv("ENABLE_AGENT_FILE_TOOLS", originalEnv.ENABLE_AGENT_FILE_TOOLS);
    setEnv("ENABLE_AGENT_APPLY_PATCH", originalEnv.ENABLE_AGENT_APPLY_PATCH);
    setEnv("ENABLE_AGENT_EXEC_TOOL", originalEnv.ENABLE_AGENT_EXEC_TOOL);
  });

  it("includes tool block guide for claude/gemini", () => {
    const base = "please do something";

    const claude = injectToolGuide(base, { activeAgentId: "claude" });
    assert.match(claude, /<<<tool\.read/);
    assert.match(claude, /<<<tool\.write/);
    assert.match(claude, /<<<tool\.apply_patch/);
    assert.match(claude, /<<<tool\.exec/);

    const gemini = injectToolGuide(base, { activeAgentId: "gemini" });
    assert.match(gemini, /<<<tool\.read/);
    assert.match(gemini, /<<<tool\.write/);
    assert.match(gemini, /<<<tool\.apply_patch/);
    assert.match(gemini, /<<<tool\.exec/);
  });

  it("does not add file/exec tool blocks for codex", () => {
    const base = "please do something";
    const codex = injectToolGuide(base, { activeAgentId: "codex" });
    assert.equal(codex, base);
  });
});


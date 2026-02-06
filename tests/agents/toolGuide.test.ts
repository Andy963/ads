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

  it("does not add file/exec tool blocks for codex (uses native tools)", () => {
    const base = "please do something";
    const codex = injectToolGuide(base, { activeAgentId: "codex" });
    assert.ok(!codex.includes("<<<tool.read"), "codex should not have tool.read blocks");
    assert.ok(!codex.includes("<<<tool.write"), "codex should not have tool.write blocks");
  });

  it("includes tool block guide for non-codex agents", () => {
    const base = "please do something";
    const other = injectToolGuide(base, { activeAgentId: "other" });
    assert.ok(!other.includes("<<<tool.read"), "non-codex should not have tool.read blocks");
    assert.match(other, /<<<tool\.write/);
    assert.match(other, /<<<tool\.apply_patch/);
    assert.match(other, /<<<tool\.exec/);
  });
});

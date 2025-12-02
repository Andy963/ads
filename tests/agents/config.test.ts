import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getAgentFeatureFlags, resolveClaudeAgentConfig } from "../../src/agents/config.js";

describe("agents/config", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.ENABLE_CLAUDE_AGENT = process.env.ENABLE_CLAUDE_AGENT;
    originalEnv.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
    originalEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    originalEnv.CLAUDE_MODEL = process.env.CLAUDE_MODEL;
    originalEnv.CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR;
    originalEnv.CLAUDE_BASE_URL = process.env.CLAUDE_BASE_URL;
    originalEnv.CLAUDE_TOOL_ALLOWLIST = process.env.CLAUDE_TOOL_ALLOWLIST;

    process.env.ENABLE_CLAUDE_AGENT = "1";
    process.env.CLAUDE_API_KEY = "sk-ant-test";
    process.env.CLAUDE_MODEL = "claude-custom";
    process.env.CLAUDE_WORKDIR = "/tmp/ads-claude-test";
    process.env.CLAUDE_BASE_URL = "https://claude.example.com";
    process.env.CLAUDE_TOOL_ALLOWLIST = "bash,file.edit";
  });

  afterEach(() => {
    process.env.ENABLE_CLAUDE_AGENT = originalEnv.ENABLE_CLAUDE_AGENT;
    process.env.CLAUDE_API_KEY = originalEnv.CLAUDE_API_KEY;
    process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    process.env.CLAUDE_MODEL = originalEnv.CLAUDE_MODEL;
    process.env.CLAUDE_WORKDIR = originalEnv.CLAUDE_WORKDIR;
    process.env.CLAUDE_BASE_URL = originalEnv.CLAUDE_BASE_URL;
    process.env.CLAUDE_TOOL_ALLOWLIST = originalEnv.CLAUDE_TOOL_ALLOWLIST;
  });

  it("respects env feature flags when present", () => {
    const flags = getAgentFeatureFlags();
    assert.equal(flags.claudeEnabled, true);
    assert.equal(flags.geminiEnabled, false);
  });

  it("resolves Claude config from env values", () => {
    const cfg = resolveClaudeAgentConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.apiKey, "sk-ant-test");
    assert.equal(cfg.model, "claude-custom");
    assert.equal(cfg.workdir, "/tmp/ads-claude-test");
    assert.equal(cfg.baseUrl, "https://claude.example.com");
    assert.deepEqual(cfg.toolAllowlist, ["bash", "file.edit"]);
  });
});

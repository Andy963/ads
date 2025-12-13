import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { getAgentFeatureFlags, resolveClaudeAgentConfig, resolveGeminiAgentConfig } from "../../src/agents/config.js";

describe("agents/config", () => {
  const originalEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    originalEnv.ENABLE_CLAUDE_AGENT = process.env.ENABLE_CLAUDE_AGENT;
    originalEnv.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
    originalEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    originalEnv.CLAUDE_MODEL = process.env.CLAUDE_MODEL;
    originalEnv.CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR;
    originalEnv.CLAUDE_BASE_URL = process.env.CLAUDE_BASE_URL;
    originalEnv.CLAUDE_TOOL_ALLOWLIST = process.env.CLAUDE_TOOL_ALLOWLIST;
    originalEnv.ENABLE_GEMINI_AGENT = process.env.ENABLE_GEMINI_AGENT;
    originalEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    originalEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    originalEnv.GEMINI_MODEL = process.env.GEMINI_MODEL;

    setEnv("ENABLE_CLAUDE_AGENT", "1");
    setEnv("CLAUDE_API_KEY", "sk-ant-test");
    setEnv("ANTHROPIC_API_KEY", undefined);
    setEnv("CLAUDE_MODEL", "claude-custom");
    setEnv("CLAUDE_WORKDIR", "/tmp/ads-claude-test");
    setEnv("CLAUDE_BASE_URL", "https://claude.example.com");
    setEnv("CLAUDE_TOOL_ALLOWLIST", "bash,file.edit");
    setEnv("ENABLE_GEMINI_AGENT", undefined);
    setEnv("GEMINI_API_KEY", undefined);
    setEnv("GOOGLE_API_KEY", undefined);
    setEnv("GEMINI_MODEL", undefined);
  });

  afterEach(() => {
    setEnv("ENABLE_CLAUDE_AGENT", originalEnv.ENABLE_CLAUDE_AGENT);
    setEnv("CLAUDE_API_KEY", originalEnv.CLAUDE_API_KEY);
    setEnv("ANTHROPIC_API_KEY", originalEnv.ANTHROPIC_API_KEY);
    setEnv("CLAUDE_MODEL", originalEnv.CLAUDE_MODEL);
    setEnv("CLAUDE_WORKDIR", originalEnv.CLAUDE_WORKDIR);
    setEnv("CLAUDE_BASE_URL", originalEnv.CLAUDE_BASE_URL);
    setEnv("CLAUDE_TOOL_ALLOWLIST", originalEnv.CLAUDE_TOOL_ALLOWLIST);
    setEnv("ENABLE_GEMINI_AGENT", originalEnv.ENABLE_GEMINI_AGENT);
    setEnv("GEMINI_API_KEY", originalEnv.GEMINI_API_KEY);
    setEnv("GOOGLE_API_KEY", originalEnv.GOOGLE_API_KEY);
    setEnv("GEMINI_MODEL", originalEnv.GEMINI_MODEL);
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

  it("enables Gemini when API key is present", () => {
    setEnv("ENABLE_GEMINI_AGENT", undefined);
    setEnv("GEMINI_API_KEY", "gm-test");
    const flags = getAgentFeatureFlags();
    assert.equal(flags.geminiEnabled, true);
  });

  it("resolves Gemini config from env values", () => {
    setEnv("ENABLE_GEMINI_AGENT", "1");
    setEnv("GEMINI_API_KEY", "gm-test");
    setEnv("GEMINI_MODEL", "gemini-custom");
    const cfg = resolveGeminiAgentConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.apiKey, "gm-test");
    assert.equal(cfg.model, "gemini-custom");
  });
});

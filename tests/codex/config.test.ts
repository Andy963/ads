import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveCodexConfig, maskKey, parseSlashCommand } from "../../src/codexConfig.js";

describe("codexConfig", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.CODEX_BASE_URL = process.env.CODEX_BASE_URL;
    originalEnv.CODEX_API_KEY = process.env.CODEX_API_KEY;
    originalEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    process.env.CODEX_BASE_URL = "https://api.example.com/v1";
    process.env.CODEX_API_KEY = "sk-test-1234567890";
  });

  afterEach(() => {
    process.env.CODEX_BASE_URL = originalEnv.CODEX_BASE_URL;
    process.env.CODEX_API_KEY = originalEnv.CODEX_API_KEY;
    process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
  });

  it("resolves config from env and overrides", () => {
    const cfg = resolveCodexConfig({ baseUrl: "https://override.example.com" });
    assert.equal(cfg.baseUrl, "https://override.example.com");
    assert.equal(cfg.apiKey, "sk-test-1234567890");
  });

  it("masks keys for display", () => {
    assert.equal(maskKey("short"), "short");
    assert.equal(maskKey("abcdefghijk"), "abcd…hijk");
  });

  it("parses slash commands", () => {
    assert.deepEqual(parseSlashCommand("/ads.status"), { command: "ads.status", body: "" });
    assert.deepEqual(parseSlashCommand("/ads.new Hello World"), { command: "ads.new", body: "Hello World" });
    assert.equal(parseSlashCommand("not a command"), null);
  });
});

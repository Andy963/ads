import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { resolveCodexConfig, maskKey, parseSlashCommand } from "../../src/codexConfig.js";

describe("codexConfig", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let tempHomeDir: string | null = null;

  beforeEach(() => {
    originalEnv.CODEX_BASE_URL = process.env.CODEX_BASE_URL;
    originalEnv.CODEX_API_KEY = process.env.CODEX_API_KEY;
    originalEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    originalEnv.HOME = process.env.HOME;
    originalEnv.USERPROFILE = process.env.USERPROFILE;
    process.env.CODEX_BASE_URL = "https://api.example.com/v1";
    process.env.CODEX_API_KEY = "sk-test-1234567890";
  });

  afterEach(() => {
    process.env.CODEX_BASE_URL = originalEnv.CODEX_BASE_URL;
    process.env.CODEX_API_KEY = originalEnv.CODEX_API_KEY;
    process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
    process.env.HOME = originalEnv.HOME;
    process.env.USERPROFILE = originalEnv.USERPROFILE;
    if (tempHomeDir) {
      rmSync(tempHomeDir, { recursive: true, force: true });
      tempHomeDir = null;
    }
  });

  it("resolves config from env and overrides", () => {
    const cfg = resolveCodexConfig({ baseUrl: "https://override.example.com" });
    assert.equal(cfg.baseUrl, "https://override.example.com");
    assert.equal(cfg.apiKey, "sk-test-1234567890");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("masks keys for display", () => {
    assert.equal(maskKey(), "(none)");
    assert.equal(maskKey("short"), "short");
    assert.equal(maskKey("abcdefghijk"), "abcd…hijk");
  });

  it("falls back to device-auth tokens when API key is missing", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({
        last_refresh: "2024-01-01T00:00:00Z",
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          id_token: "id",
          account_id: "account",
        },
      }),
      "utf-8"
    );
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.authMode, "deviceAuth");
    assert.equal(cfg.apiKey, undefined);
    assert.equal(cfg.baseUrl, undefined);
  });

  it("parses slash commands", () => {
    assert.deepEqual(parseSlashCommand("/ads.status"), { command: "ads.status", body: "" });
    assert.deepEqual(parseSlashCommand("/ads.new Hello World"), { command: "ads.new", body: "Hello World" });
    assert.equal(parseSlashCommand("not a command"), null);
  });
});

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
    originalEnv.CODEX_HOME = process.env.CODEX_HOME;
    originalEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    originalEnv.HOME = process.env.HOME;
    originalEnv.USERPROFILE = process.env.USERPROFILE;
    process.env.CODEX_BASE_URL = "https://api.example.com/v1";
    process.env.CODEX_API_KEY = "sk-test-1234567890";
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    process.env.CODEX_BASE_URL = originalEnv.CODEX_BASE_URL;
    process.env.CODEX_API_KEY = originalEnv.CODEX_API_KEY;
    process.env.CODEX_HOME = originalEnv.CODEX_HOME;
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

  it("defaults baseUrl when API key is present but no base is provided", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    const cfg = resolveCodexConfig({ apiKey: "sk-temp-123" });
    assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
    assert.equal(cfg.apiKey, "sk-temp-123");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("keeps existing baseUrl if provided alongside apiKey", () => {
    const cfg = resolveCodexConfig({ baseUrl: "https://custom.example.com/v1", apiKey: "sk-inline" });
    assert.equal(cfg.baseUrl, "https://custom.example.com/v1");
    assert.equal(cfg.apiKey, "sk-inline");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("throws when no credentials are available", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    assert.throws(
      () => resolveCodexConfig(),
      /Codex credentials not found/i
    );
  });

  it("throws when baseUrl exists but no apiKey and no tokens", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model_provider = "test"',
        "[model_providers.test]",
        'base_url = "https://only-base.example.com/v1"',
      ].join("\n"),
      "utf-8"
    );
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    assert.throws(() => resolveCodexConfig(), /credentials not found/i);
  });

  it("loads baseUrl and apiKey from config.toml provider section", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model_provider = "test"',
        "[model_providers.test]",
        'base_url = "https://from-config.example.com/v1"',
        'api_key = "sk-from-config"',
      ].join("\n"),
      "utf-8"
    );
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.baseUrl, "https://from-config.example.com/v1");
    assert.equal(cfg.apiKey, "sk-from-config");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("respects CODEX_HOME for config lookup", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexHome = join(tempHomeDir, "codex-home");
    const otherHome = join(tempHomeDir, "other-home");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(otherHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model_provider = "test"',
        "[model_providers.test]",
        'base_url = "https://from-codex-home.example.com/v1"',
        'api_key = "sk-from-codex-home"',
      ].join("\n"),
      "utf-8",
    );

    process.env.CODEX_HOME = codexHome;
    process.env.HOME = otherHome;
    process.env.USERPROFILE = otherHome;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.baseUrl, "https://from-codex-home.example.com/v1");
    assert.equal(cfg.apiKey, "sk-from-codex-home");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("expands ~ in CODEX_HOME", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const fakeHome = join(tempHomeDir, "fake-home");
    mkdirSync(fakeHome, { recursive: true });

    const resolvedCodexHome = join(fakeHome, ".codex-home");
    mkdirSync(resolvedCodexHome, { recursive: true });
    writeFileSync(
      join(resolvedCodexHome, "config.toml"),
      [
        'model_provider = "test"',
        "[model_providers.test]",
        'base_url = "https://from-tilde.example.com/v1"',
        'api_key = "sk-from-tilde"',
      ].join("\n"),
      "utf-8",
    );

    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.CODEX_HOME = "~/.codex-home";

    const cfg = resolveCodexConfig();
    assert.equal(cfg.baseUrl, "https://from-tilde.example.com/v1");
    assert.equal(cfg.apiKey, "sk-from-tilde");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("loads modelReasoningEffort from config.toml", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model_provider = "test"',
        "[model_providers.test]",
        'base_url = "https://from-config.example.com/v1"',
        'api_key = "sk-from-config"',
        'model_reasoning_effort = "high"',
      ].join("\n"),
      "utf-8"
    );
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.modelReasoningEffort, "high");
  });

  it("falls back to first provider baseUrl when model_provider is missing", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    process.env.CODEX_API_KEY = "sk-env-provider";

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        "[model_providers.first]",
        'base_url = "https://first.example.com/v1"',
        'api_key = "sk-first-ignored"',
        "[model_providers.second]",
        'base_url = "https://second.example.com/v1"',
        'api_key = "sk-second-ignored"',
      ].join("\n"),
      "utf-8"
    );
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.baseUrl, "https://first.example.com/v1");
    assert.equal(cfg.apiKey, "sk-env-provider");
    assert.equal(cfg.authMode, "apiKey");
  });

  it("ignores malformed auth/config files and still prefers env", () => {
    process.env.CODEX_BASE_URL = "https://env.example.com/v1";
    process.env.CODEX_API_KEY = "sk-env";
    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), "not=toml", "utf-8");
    writeFileSync(join(codexDir, "auth.json"), "{not-json", "utf-8");
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.baseUrl, "https://env.example.com/v1");
    assert.equal(cfg.apiKey, "sk-env");
    assert.equal(cfg.authMode, "apiKey");
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
    assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  });

  it("uses config baseUrl with device tokens when no API key", () => {
    delete process.env.CODEX_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempHomeDir = mkdtempSync(join(tmpdir(), "codex-config-"));
    const codexDir = join(tempHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model_provider = "test"',
        "[model_providers.test]",
        'base_url = "https://config-only.example.com/v1"',
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          id_token: "id",
        },
      }),
      "utf-8"
    );
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;

    const cfg = resolveCodexConfig();
    assert.equal(cfg.authMode, "deviceAuth");
    assert.equal(cfg.apiKey, undefined);
    assert.equal(cfg.baseUrl, "https://config-only.example.com/v1");
  });

  it("parses slash commands", () => {
    assert.deepEqual(parseSlashCommand("/ads.status"), { command: "ads.status", body: "" });
    assert.deepEqual(parseSlashCommand("/ads.new Hello World"), { command: "ads.new", body: "Hello World" });
    assert.equal(parseSlashCommand("not a command"), null);
    assert.equal(parseSlashCommand("/   "), null);
    assert.deepEqual(parseSlashCommand("/ads.new    spaced   body "), { command: "ads.new", body: "spaced   body" });
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { sanitizeModelConfigJson } from "../../server/state/modelConfigTypes.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";

describe("model token configuration sanitization", () => {
  for (const [key, minimum] of [["max_input_tokens", 256], ["max_output_tokens", 1]] as const) {
    it(`normalizes valid ${key} values without clamping`, () => {
      for (const value of [minimum, 512, 131_072, 262_144, 1_048_576, 2_000_000, 100_000_000]) {
        for (const raw of [value, String(value), ` ${value} `]) {
          const config = Object.freeze({ [key]: raw });
          assert.deepEqual(sanitizeModelConfigJson(config), { [key]: value });
          assert.equal(config[key], raw);
        }
      }
    });

    it(`deletes invalid ${key} values instead of coercing or defaulting`, () => {
      for (const value of [
        undefined, null, true, false, "", " ", "invalid", "12tokens", 0, -1, minimum - 1,
        minimum + 0.5, String(minimum + 0.5), NaN, Infinity, -Infinity, "Infinity", "NaN",
        100_000_001, "100000001", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
        [], [minimum], {},
      ]) {
        const config = Object.freeze({ [key]: value, credentialProfile: "profile", contextWindow: 512, maxTokens: 128 });
        const sanitized = sanitizeModelConfigJson(config);
        assert.deepEqual(sanitized, { credentialProfile: "profile", contextWindow: 512, maxTokens: 128 });
        assert.equal(Object.hasOwn(sanitized ?? {}, key), false);
        assert.equal(config[key], value);
      }
    });
  }

  it("keeps unconfigured canonical fields absent even when reasoning defaults are requested", () => {
    for (const defaultUnconfigured of [false, true]) {
      for (const config of [{}, { temperature: 0.2 }, { context_window: "8192", maxTokens: "1024" }]) {
        const sanitized = sanitizeModelConfigJson(config, { defaultUnconfigured });
        assert.equal(Object.hasOwn(sanitized ?? {}, "max_input_tokens"), false);
        assert.equal(Object.hasOwn(sanitized ?? {}, "max_output_tokens"), false);
      }
      assert.equal(sanitizeModelConfigJson(null, { defaultUnconfigured }), null);
      assert.equal(sanitizeModelConfigJson(undefined, { defaultUnconfigured }), null);
    }
  });

  it("validates input and output independently and leaves legacy and unrelated configuration untouched", () => {
    const legacy = {
      contextWindow: "1024", context_window: 2048, modelContextWindow: 4096,
      model_context_window: 8192, maxContextTokens: 16384, max_context_tokens: 32768,
      maxTokens: "128", baseUrl: "https://provider.test/v1", credentialProfile: "profile",
      allowedAgents: ["native"], capabilities: { streaming: false },
    };
    assert.deepEqual(sanitizeModelConfigJson({ ...legacy, max_input_tokens: 255, max_output_tokens: "1" }), {
      ...legacy, max_output_tokens: 1,
    });
    assert.deepEqual(sanitizeModelConfigJson({ ...legacy, max_input_tokens: "256", max_output_tokens: true }), {
      ...legacy, max_input_tokens: 256,
    });
  });
});

describe("model token configuration persistence", () => {
  it("round-trips normalized token limits, invalid values and unconfigured absence across store reopen", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-model-token-config-"));
    const dbPath = path.join(directory, "state.db");
    let db = new Database(dbPath);
    try {
      const cases: Array<{
        id: string;
        config: Record<string, unknown> | null | undefined;
        expected: Record<string, unknown> | null;
      }> = [
        {
          id: "canonical",
          config: { max_input_tokens: "1048576", max_output_tokens: "2000000", credentialProfile: "profile" },
          expected: { max_input_tokens: 1_048_576, max_output_tokens: 2_000_000, credentialProfile: "profile" },
        },
        {
          id: "minimum",
          config: { max_input_tokens: "256", max_output_tokens: "1" },
          expected: { max_input_tokens: 256, max_output_tokens: 1 },
        },
        {
          id: "maximum",
          config: { max_input_tokens: 100_000_000, max_output_tokens: 100_000_000 },
          expected: { max_input_tokens: 100_000_000, max_output_tokens: 100_000_000 },
        },
        {
          id: "invalid-with-legacy",
          config: { max_input_tokens: 255, max_output_tokens: true, contextWindow: "8192", maxTokens: "1024" },
          expected: { contextWindow: "8192", maxTokens: "1024" },
        },
        { id: "invalid", config: { max_input_tokens: 100_000_001, max_output_tokens: 1.5 }, expected: {} },
        { id: "empty", config: {}, expected: {} },
        { id: "null", config: null, expected: null },
        { id: "absent", config: undefined, expected: null },
      ];
      const store = createGlobalModelConfigStore(db);
      for (const { id, config, expected } of cases) {
        const saved = store.upsertModelConfig({
          id, modelId: id, displayName: id, provider: "openai", isEnabled: true, isDefault: false,
          configJson: config,
        });
        assert.deepEqual(saved.configJson, expected);
        const row = db.prepare("SELECT config_json FROM model_configs WHERE id = ?").get(id) as { config_json: string | null };
        assert.deepEqual(row.config_json === null ? null : JSON.parse(row.config_json), expected);
      }
      db.close();
      db = new Database(dbPath);
      const reopened = createGlobalModelConfigStore(db);
      for (const { id, expected } of cases) {
        assert.deepEqual(reopened.getModelConfig(id)?.configJson, expected);
        assert.deepEqual(reopened.getModelConfigByAgentModelId(id)?.configJson, expected);
        assert.deepEqual(reopened.listModelConfigs().find(model => model.id === id)?.configJson, expected);
      }
      const configured = reopened.getModelConfig("canonical");
      assert.ok(configured);
      reopened.upsertModelConfig({ ...configured, configJson: { credentialProfile: "profile" } });
      assert.deepEqual(reopened.getModelConfig("canonical")?.configJson, { credentialProfile: "profile" });
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

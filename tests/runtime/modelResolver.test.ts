import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeAllStateDatabases, getStateDatabase } from "../../server/state/database.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createModelServiceStore } from "../../server/state/modelServiceStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { createNativeModelResolver } from "../../server/runtime/modelResolver.js";
import { completeNativeChat } from "../../server/runtime/openAiCompatibleClient.js";
import { DEFAULT_REASONING_EFFORT } from "../../server/state/modelConfigTypes.js";

describe("native model resolver", () => {
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-model-"));
    dbPath = path.join(directory, "state.db");
  });

  afterEach(() => {
    closeAllStateDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("resolves model metadata with an encrypted credential profile", () => {
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    credentials.save("42", {
      baseUrl: "https://provider.test/v1",
      provider: "custom",
      apiKey: "profile-secret",
    }, "custom-profile");
    modelStore.upsertModelConfig({
      id: "model-custom",
      modelId: "custom-model",
      displayName: "Custom",
      provider: "custom",
      isEnabled: true,
      isDefault: false,
      configJson: { credentialProfile: "custom-profile", temperature: 0.2 },
    });

    const resolved = createNativeModelResolver({
      owner: "42",
      stateDbPath: dbPath,
      env: { ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
    }).resolve("custom-model");

    assert.deepEqual(resolved, {
      model: "custom-model",
      baseUrl: "https://provider.test/v1",
      apiKey: "profile-secret",
      provider: "custom",
      options: { reasoningEffort: DEFAULT_REASONING_EFFORT, temperature: 0.2 },
    });
    const modelRow = db.prepare("SELECT config_json FROM model_configs WHERE id = ?").get("model-custom") as { config_json: string };
    assert.doesNotMatch(modelRow.config_json, /profile-secret/);
  });

  it("resolves base URL and credentials from an attached provider entity", () => {
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    createModelProviderStore(db).upsertProvider({
      id: "provider-1",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      isEnabled: true,
    });
    createUpstreamCredentialStore(db, { pepper: "test-only-pepper" }).save("42", {
      baseUrl: "https://openrouter.ai/api/v1",
      provider: "provider-1",
      apiKey: "provider-secret",
    }, "provider-1");
    modelStore.upsertModelConfig({
      id: "model-attached", modelId: "attached-model", displayName: "Attached", provider: "openai",
      providerId: "provider-1", isEnabled: true, isDefault: false,
    });

    const env = { ADS_WEB_SESSION_PEPPER: "test-only-pepper" };
    const resolved = createNativeModelResolver({ owner: "42", stateDbPath: dbPath, env }).resolve("attached-model");
    assert.equal(resolved.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(resolved.apiKey, "provider-secret");

    modelStore.upsertModelConfig({
      id: "model-orphan", modelId: "orphan-model", displayName: "Orphan", provider: "openai",
      providerId: "provider-missing", isEnabled: true, isDefault: false,
    });
    assert.throws(
      () => createNativeModelResolver({ owner: "42", stateDbPath: dbPath, env }).resolve("orphan-model"),
      /unknown provider/,
    );
  });

  it("requires saved models and credentials belonging to the owner in strict mode", () => {
    const db = getStateDatabase(dbPath);
    createGlobalModelConfigStore(db).upsertModelConfig({
      id: "strict-model", modelId: "strict-model", displayName: "Strict", provider: "openai",
      isEnabled: true, isDefault: false, configJson: {},
    });
    const env = { ADS_WEB_SESSION_PEPPER: "test-only-pepper", OPENAI_API_KEY: "server-secret", OPENAI_BASE_URL: "https://server.test/v1" };
    const resolver = (owner: string) => createNativeModelResolver({ owner, stateDbPath: dbPath, env, requireOwnerCredentials: true });
    assert.throws(() => resolver("owner-a").resolve("missing-model"), /saved model/);
    assert.throws(() => resolver("owner-a").resolve("strict-model"), /credentials are not configured/);
    createUpstreamCredentialStore(db, { pepper: env.ADS_WEB_SESSION_PEPPER }).save("owner-a", {
      baseUrl: "https://owner.test/v1", provider: "openai", apiKey: "owner-secret",
    });
    assert.equal(resolver("owner-a").resolve("strict-model").apiKey, "owner-secret");
    assert.throws(() => resolver("owner-b").resolve("strict-model"), /credentials are not configured/);
  });

  it("keeps provider-specific identities isolated and rejects models outside the conversation service", () => {
    const db = getStateDatabase(dbPath);
    const models = createGlobalModelConfigStore(db);
    const providers = createModelProviderStore(db);
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-pepper" });
    for (const id of ["provider-a", "provider-b"]) {
      providers.upsertProvider({ id, name: id, baseUrl: `https://${id}.test/v1`, wireApi: "chat", isEnabled: true });
      credentials.save("owner", { baseUrl: `https://${id}.test/v1`, provider: id, apiKey: `${id}-secret` }, id);
      models.upsertModelConfig({ id: `${id}-model`, providerId: id, provider: "openai", modelId: "shared-model",
        displayName: id, isEnabled: true, isDefault: false });
    }
    const services = createModelServiceStore(db);
    services.save("conversation", ["provider-a-model", "provider-b-model"], "provider-a-model");
    const resolver = createNativeModelResolver({ owner: "owner", stateDbPath: dbPath, env: { ADS_WEB_SESSION_PEPPER: "test-pepper" } });
    for (const id of ["provider-a", "provider-b"]) {
      const resolved = resolver.resolve(`${id}-model`);
      assert.equal(resolved.model, "shared-model");
      assert.equal(resolved.baseUrl, `https://${id}.test/v1`);
      assert.equal(resolved.apiKey, `${id}-secret`);
    }
    assert.throws(() => resolver.resolve("shared-model"), /ambiguous/i);
    services.save("conversation", ["provider-a-model"], "provider-a-model");
    assert.throws(() => resolver.resolve("provider-b-model"), /enabled conversation model/i);
  });

  it("rejects unsupported provider wire formats before sending a native request", () => {
    const db = getStateDatabase(dbPath);
    const providers = createModelProviderStore(db);
    const provider = { id: "provider-wire", name: "Wire provider", baseUrl: "https://wire.test/v1", isEnabled: true };
    providers.upsertProvider({ ...provider, wireApi: "responses" });
    createGlobalModelConfigStore(db).upsertModelConfig({ id: "wire-model", providerId: provider.id, provider: "openai",
      modelId: "upstream-model", displayName: "Wire model", isEnabled: true, isDefault: false });
    createUpstreamCredentialStore(db, { pepper: "test-pepper" }).save("owner", {
      baseUrl: provider.baseUrl, provider: provider.id, apiKey: "wire-secret",
    }, provider.id);
    const resolver = createNativeModelResolver({ owner: "owner", stateDbPath: dbPath, env: { ADS_WEB_SESSION_PEPPER: "test-pepper" } });
    assert.throws(() => resolver.resolve("wire-model"), /Native runtime supports only Chat Completions/i);
    providers.upsertProvider({ ...provider, wireApi: "unknown" });
    assert.throws(() => resolver.resolve("wire-model"), /Native runtime supports only Chat Completions/i);
    for (const wireApi of ["chat", null]) {
      providers.upsertProvider({ ...provider, wireApi, name: "Renamed provider" });
      assert.equal(resolver.resolve("wire-model").apiKey, "wire-secret");
    }
  });

  it("falls back to the default effort when the configured value is invalid", () => {
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    credentials.save("42", {
      baseUrl: "https://provider.test/v1",
      provider: "custom",
      apiKey: "profile-secret",
    }, "custom-profile");
    modelStore.upsertModelConfig({
      id: "model-invalid-reasoning",
      modelId: "custom-model-invalid-reasoning",
      displayName: "Custom",
      provider: "custom",
      isEnabled: true,
      isDefault: false,
      configJson: {
        credentialProfile: "custom-profile",
        reasoningEfforts: ["high"],
        reasoningEffort: "bogus",
      },
    });

    const resolver = createNativeModelResolver({
      owner: "42",
      stateDbPath: dbPath,
      env: { ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
    });
    assert.deepEqual(resolver.resolve("custom-model-invalid-reasoning").options, {
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    });
    assert.deepEqual(
      resolver.resolve("custom-model-invalid-reasoning", {
        credentialProfile: "custom-profile",
        reasoningEffort: "bogus",
      }).options,
      { reasoningEffort: DEFAULT_REASONING_EFFORT },
    );
    assert.deepEqual(
      resolver.resolve("custom-model-invalid-reasoning", {
        credentialProfile: "custom-profile",
        reasoningEffort: "ultra",
      }).options,
      { reasoningEffort: "ultra" },
    );
  });

  it("rejects a model endpoint that does not match its credential profile", () => {
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    credentials.save("42", { baseUrl: "https://provider.test/v1", provider: "custom", apiKey: "secret" }, "custom");
    modelStore.upsertModelConfig({
      id: "model-custom",
      modelId: "custom-model",
      displayName: "Custom",
      provider: "custom",
      isEnabled: true,
      isDefault: false,
      configJson: { credentialProfile: "custom", baseUrl: "https://other.test/v1" },
    });

    assert.throws(
      () => createNativeModelResolver({ owner: "42", stateDbPath: dbPath, env: { ADS_WEB_SESSION_PEPPER: "test-only-pepper" } }).resolve("custom-model"),
      /does not match/i,
    );
  });

  it("keeps seeded OpenAI model rows compatible with the Codex environment", () => {
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    modelStore.upsertModelConfig({
      id: "model-seeded",
      modelId: "seeded-model",
      displayName: "Seeded",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: { allowedAgents: ["codex"] },
    });

    const resolved = createNativeModelResolver({
      owner: "42",
      stateDbPath: dbPath,
      env: { OPENAI_API_KEY: "environment-secret", OPENAI_BASE_URL: "https://env.test/v1" },
    }).resolve("seeded-model");

    assert.equal(resolved.apiKey, "environment-secret");
    assert.equal(resolved.baseUrl, "https://env.test/v1");
  });

  it("does not borrow a default credential from another provider", () => {
    const db = getStateDatabase(dbPath);
    const modelStore = createGlobalModelConfigStore(db);
    const credentials = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    credentials.save("42", { baseUrl: "https://custom.test/v1", provider: "custom", apiKey: "custom-secret" });
    modelStore.upsertModelConfig({
      id: "model-openai",
      modelId: "openai-model",
      displayName: "OpenAI",
      provider: "openai",
      isEnabled: true,
      isDefault: false,
      configJson: null,
    });

    assert.throws(
      () => createNativeModelResolver({
        owner: "42",
        stateDbPath: dbPath,
        env: { ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      }).resolve("openai-model"),
      /does not match|credentials are not configured/i,
    );
  });

  function createTokenResolver() {
    const models = createGlobalModelConfigStore(getStateDatabase(dbPath));
    models.upsertModelConfig({
      id: "token-model", modelId: "token-model", displayName: "Token model", provider: "openai",
      isEnabled: true, isDefault: false,
      configJson: { max_input_tokens: "262144", max_output_tokens: "131072" },
    });
    return createNativeModelResolver({
      owner: "token-owner",
      stateDbPath: dbPath,
      env: {
        OPENAI_API_KEY: "environment-secret",
        OPENAI_BASE_URL: "https://env.test/v1",
        ADS_NATIVE_CONTEXT_WINDOW: "8192",
        ADS_NATIVE_CONTEXT_RESERVED_TOKENS: "2048",
      },
    });
  }

  it("resolves saved canonical token limits and prefers them over legacy overrides", () => {
    const resolver = createTokenResolver();
    const saved = resolver.resolve("token-model");
    assert.equal(saved.contextWindow, 262_144);
    assert.equal(saved.options?.maxTokens, 131_072);

    const overridden = resolver.resolve("token-model", {
      max_input_tokens: "1048576", contextWindow: 8192,
      max_output_tokens: "2000000", maxTokens: 4096,
    });
    assert.equal(overridden.contextWindow, 1_048_576);
    assert.equal(overridden.options?.maxTokens, 2_000_000);
    assert.equal(overridden.apiKey, saved.apiKey);
    assert.equal(overridden.baseUrl, saved.baseUrl);
    assert.equal(overridden.provider, saved.provider);
  });

  for (const model of ["token-model", "unsaved-token-model"]) {
    it(`supports numeric boundaries and strings for ${model}`, () => {
      const resolver = createTokenResolver();
      for (const context of [256, 512, 8192, 1_048_576, 100_000_000]) {
        for (const output of [1, 131_072, 2_000_000, 100_000_000]) {
          for (const asString of [false, true]) {
            const resolved = resolver.resolve(model, {
              max_input_tokens: asString ? ` ${context} ` : context,
              max_output_tokens: asString ? ` ${output} ` : output,
            });
            assert.equal(resolved.contextWindow, context);
            assert.equal(resolved.options?.maxTokens, output);
          }
        }
      }
    });

    it(`falls back to valid legacy limits and rejects malformed numbers for ${model}`, () => {
      const resolver = createTokenResolver();
      const invalid = [
        undefined, null, true, false, "", " ", "bad", 0, -1, 256.5, "256.5",
        NaN, Infinity, -Infinity, "Infinity", 100_000_001, "100000001", Number.MAX_SAFE_INTEGER,
        [], [512], {},
      ];
      for (const value of invalid) {
        const resolved = resolver.resolve(model, {
          max_input_tokens: value, contextWindow: "1048576",
          max_output_tokens: value, maxTokens: "2000000",
        });
        assert.equal(resolved.contextWindow, 1_048_576);
        assert.equal(resolved.options?.maxTokens, 2_000_000);
        for (const config of [
          { max_input_tokens: value, max_output_tokens: value },
          { contextWindow: value, maxTokens: value },
        ]) {
          const rejected = resolver.resolve(model, config);
          assert.equal(rejected.contextWindow, undefined);
          assert.equal(rejected.options?.maxTokens, undefined);
        }
      }
      const tooSmall = resolver.resolve(model, { max_input_tokens: 255, contextWindow: 512 });
      assert.equal(tooSmall.contextWindow, 512);
      assert.equal(resolver.resolve(model, { max_input_tokens: 255 }).contextWindow, undefined);
    });

    it(`preserves legacy context aliases and their precedence for ${model}`, () => {
      const resolver = createTokenResolver();
      const aliases = [
        "contextWindow", "context_window", "modelContextWindow", "model_context_window",
        "maxContextTokens", "max_context_tokens",
      ];
      for (const [index, key] of aliases.entries()) {
        const config: Record<string, unknown> = Object.fromEntries(aliases.slice(0, index).map(alias => [alias, false]));
        config[key] = "1048576";
        const resolved = resolver.resolve(model, { ...config, max_input_tokens: null, maxTokens: "100000000" });
        assert.equal(resolved.contextWindow, 1_048_576);
        assert.equal(resolved.options?.maxTokens, 100_000_000);
      }
      assert.equal(resolver.resolve(model, { contextWindow: 512, context_window: 1024 }).contextWindow, 512);
    });

    it(`does not inject token defaults or environment limits for ${model}`, () => {
      const resolver = createTokenResolver();
      const resolved = resolver.resolve(model, {});
      assert.equal(resolved.contextWindow, undefined);
      assert.equal(resolved.options?.maxTokens, undefined);
      assert.equal(Object.hasOwn(resolved, "contextWindow"), false);
      assert.equal(Object.hasOwn(resolved.options ?? {}, "maxTokens"), false);
    });

    for (const streaming of [true, false]) {
      it(`forwards resolved output limits as max_tokens for ${model} (streaming=${streaming})`, async () => {
        const resolver = createTokenResolver();
        const resolved = resolver.resolve(model, { max_input_tokens: "1048576", max_output_tokens: "2000000" });
        let body: Record<string, unknown> | undefined;
        await completeNativeChat({
          ...resolved,
          messages: [{ role: "user", content: "Hello" }],
          tools: [],
          streaming,
          fetchImpl: async (url, init) => {
            assert.equal(String(url), "https://env.test/v1/chat/completions");
            assert.equal(new Headers(init?.headers).get("authorization"), "Bearer environment-secret");
            body = JSON.parse(String(init?.body));
            return streaming
              ? new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
                headers: { "content-type": "text/event-stream" },
              })
              : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
          },
        });
        assert.equal(body?.max_tokens, 2_000_000);
        assert.equal(body?.max_output_tokens, undefined);
        assert.equal(body?.max_input_tokens, undefined);
        assert.equal(body?.contextWindow, undefined);
      });
    }
  }

  it("honors unsaved token overrides without adopting credential, endpoint or reasoning overrides", () => {
    const resolver = createTokenResolver();
    const original = resolver.resolve("unsaved-token-model");
    const overridden = resolver.resolve("unsaved-token-model", {
      max_input_tokens: 512, max_output_tokens: 128,
      baseUrl: "https://other.test/v1", apiKey: "override-secret", credentialProfile: "other-profile",
      provider: "other-provider", owner: "other-owner", reasoningEffort: "off",
    });
    assert.deepEqual(overridden, {
      ...original,
      contextWindow: 512,
      options: { ...original.options, maxTokens: 128 },
    });
    assert.equal(original.contextWindow, undefined);
    assert.equal(original.options?.maxTokens, undefined);
    assert.throws(() => createNativeModelResolver({
      owner: "token-owner", stateDbPath: dbPath, requireOwnerCredentials: true,
      env: { OPENAI_API_KEY: "environment-secret", OPENAI_BASE_URL: "https://env.test/v1" },
    }).resolve("unsaved-token-model", { max_input_tokens: 512, max_output_tokens: 128 }), /saved model/);
  });
});

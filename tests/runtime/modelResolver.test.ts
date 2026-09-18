import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeAllStateDatabases, getStateDatabase } from "../../server/state/database.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { createNativeModelResolver } from "../../server/runtime/modelResolver.js";

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
      options: { temperature: 0.2 },
    });
    const modelRow = db.prepare("SELECT config_json FROM model_configs WHERE id = ?").get("model-custom") as { config_json: string };
    assert.doesNotMatch(modelRow.config_json, /profile-secret/);
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
});

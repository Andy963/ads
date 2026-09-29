import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";

describe("model provider store", () => {
  let directory: string;
  let db: Database.Database;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-providers-"));
    db = new Database(path.join(directory, "state.db"));
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  it("creates, lists, updates, and deletes named providers", () => {
    const store = createModelProviderStore(db);
    const created = store.upsertProvider({
      id: "provider-1",
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      wireApi: "responses",
      isEnabled: true,
    });
    assert.equal(created.name, "openrouter");
    assert.equal(created.credentialProfile, null);

    store.upsertProvider({
      id: "provider-2",
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      credentialProfile: "groq-profile",
      isEnabled: false,
    });
    const listed = store.listProviders();
    assert.equal(listed.length, 2);
    assert.equal(store.getProvider("provider-2")?.isEnabled, false);
    assert.equal(store.getProvider("provider-2")?.credentialProfile, "groq-profile");

    store.upsertProvider({ ...created, name: "renamed" });
    assert.equal(store.getProvider("provider-1")?.name, "renamed");

    assert.equal(store.deleteProvider("provider-2"), true);
    assert.equal(store.getProvider("provider-2"), null);
    assert.equal(store.deleteProvider("provider-2"), false);
  });

  it("rejects invalid provider rows", () => {
    const store = createModelProviderStore(db);
    assert.throws(() => store.upsertProvider({ id: "", name: "x", baseUrl: "https://x.test/v1", isEnabled: true }), /id is required/);
    assert.throws(() => store.upsertProvider({ id: "p", name: "", baseUrl: "https://x.test/v1", isEnabled: true }), /name is required/);
    assert.throws(() => store.upsertProvider({ id: "p", name: "x", baseUrl: "", isEnabled: true }), /baseUrl is required/);
  });

  it("preserves model configs with a null provider reference and detaches on provider delete", () => {
    const store = createModelProviderStore(db);
    const modelStore = createGlobalModelConfigStore(db);
    store.upsertProvider({ id: "provider-1", name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", isEnabled: true });
    modelStore.upsertModelConfig({
      id: "model-1",
      modelId: "gpt-5.2",
      displayName: "GPT 5.2",
      provider: "openai",
      providerId: "provider-1",
      isEnabled: true,
      isDefault: false,
    });
    // A legacy row carrying only a free-form provider string keeps provider_id NULL.
    modelStore.upsertModelConfig({
      id: "model-legacy",
      modelId: "legacy-model",
      displayName: "Legacy",
      provider: "custom-legacy",
      isEnabled: true,
      isDefault: false,
    });
    assert.equal(modelStore.getModelConfig("model-1")?.providerId, "provider-1");
    assert.equal(modelStore.getModelConfig("model-legacy")?.providerId, null);

    store.deleteProvider("provider-1");
    const detached = modelStore.getModelConfig("model-1");
    assert.ok(detached, "model config must survive provider deletion");
    assert.equal(detached.providerId, null);
    assert.equal(detached.provider, "openai");
    assert.equal(modelStore.getModelConfig("model-legacy")?.provider, "custom-legacy");
  });

  it("adds the provider_id column to pre-existing model_configs without touching rows", () => {
    db.exec(`CREATE TABLE model_configs (
      id TEXT PRIMARY KEY,
      model_id TEXT,
      display_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      config_json TEXT,
      updated_at INTEGER
    )`);
    db.prepare(`INSERT INTO model_configs (id, model_id, display_name, provider, is_enabled, is_default)
      VALUES ('legacy-1', 'gpt-4o', 'GPT 4o', 'openai', 1, 0)`).run();

    const modelStore = createGlobalModelConfigStore(db);
    const columns = db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name?: string }>;
    assert.ok(columns.some((column) => column.name === "provider_id"));
    const migrated = modelStore.getModelConfig("legacy-1");
    assert.ok(migrated);
    assert.equal(migrated.provider, "openai");
    assert.equal(migrated.providerId, null);
  });
});

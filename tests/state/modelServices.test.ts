import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createModelServiceStore } from "../../server/state/modelServiceStore.js";
import { createLanePromptStore, ensureLanePromptTables } from "../../server/state/lanePromptStore.js";
import { getRoleProfiles, saveRoleProfile } from "../../server/state/roleProfileStore.js";
import { stateSchemaMigrations } from "../../server/state/schemaMigrations.js";

describe("model service membership", () => {
  it("allows multiple candidates but one default independently per service", () => {
    const db = new Database(":memory:");
    try {
      const services = createModelServiceStore(db);
      const providers = createModelProviderStore(db);
      const models = createGlobalModelConfigStore(db);
      for (const id of ["one", "two"]) {
        providers.upsertProvider({ id, name: id, baseUrl: `https://${id}.invalid/v1`, isEnabled: true });
        models.upsertModelConfig({ id, providerId: id, modelId: "shared-name", provider: id, displayName: id, isEnabled: true, isDefault: false });
      }
      assert.equal(services.listModels("conversation").length, 0);
      services.save("transcription", ["one", "two"], "one");
      services.save("correction", ["one", "two"], "two");
      assert.equal(services.resolveDefault("transcription").providerId, "one");
      assert.equal(services.resolveDefault("correction").providerId, "two");
      assert.throws(() => services.save("transcription", ["one"], "two"), /default/);
      assert.deepEqual(services.get("transcription").modelIds, ["one", "two"]);
      assert.equal(services.get("transcription").defaultModelId, "one");
      services.save("conversation", ["one", "two"], "two");
      assert.equal(services.resolveConversation("one").providerId, "one");
      assert.throws(() => services.resolveConversation("shared-name"), /ambiguous/);
      assert.throws(() => models.getModelConfigByAgentModelId("shared-name"), /Ambiguous/);
      assert.equal(models.getModelConfigByAgentModelId("shared-name", "two")?.id, "two");
      services.save("transcription", [], null);
      assert.throws(() => services.resolveDefault("transcription"), /default/);
    } finally { db.close(); }
  });

  it("does not re-enable models when stores reopen or a provider is disabled", () => {
    const db = new Database(":memory:");
    try {
      const models = createGlobalModelConfigStore(db);
      models.upsertModelConfig({ id: "legacy", modelId: "legacy", provider: "openai", displayName: "Legacy", isEnabled: true, isDefault: true });
      const services = createModelServiceStore(db);
      assert.equal(services.get("conversation").defaultModelId, "legacy");
      services.save("conversation", [], null);
      assert.deepEqual(createModelServiceStore(db).get("conversation").modelIds, []);
      const provider = { id: "p", name: "Provider", baseUrl: "https://provider.invalid/v1", isEnabled: true };
      createModelProviderStore(db).upsertProvider(provider);
      models.upsertModelConfig({ id: "m", modelId: "whisper", provider: "p", providerId: "p", displayName: "Whisper", isEnabled: true, isDefault: false });
      services.save("transcription", ["m"], "m");
      createModelProviderStore(db).upsertProvider({ ...provider, isEnabled: false });
      assert.throws(() => services.resolveDefault("transcription"), /default/);
    } finally { db.close(); }
  });
});

describe("single role prompt authority", () => {
  it("migrates the editor-visible prompt, drops history and never recreates it", () => {
    const db = new Database(":memory:");
    try {
      for (const migration of stateSchemaMigrations.slice(0, 30)) db.transaction(() => migration.up(db))();
      ensureLanePromptTables(db);
      db.prepare("INSERT INTO lane_system_prompt_versions VALUES (?, 99, ?, 0, 1)").run("actions", "Visible editor prompt");
      db.prepare("UPDATE lane_system_prompt_state SET current_version = 99 WHERE lane = ?").run("actions");
      db.prepare("UPDATE role_profiles SET system_prompt = ? WHERE role = ?").run("Stale second copy", "developer");
      const migrate = stateSchemaMigrations[30];
      db.transaction(() => migrate.up(db))();
      db.transaction(() => migrate.up(db))();
      const store = createLanePromptStore(db);
      assert.equal(store.getActiveLanePrompt("actions").prompt, "Visible editor prompt");
      for (let index = 0; index < 4; index++) store.setLanePrompt("actions", `Current prompt ${index}`);
      const profile = getRoleProfiles(db, "developer")[0];
      assert.equal(profile.system_prompt, "Current prompt 3");
      saveRoleProfile(db, { ...profile, system_prompt: "Saved through role API", is_default: true, is_enabled: true });
      assert.equal(store.getActiveLanePrompt("actions").prompt, "Saved through role API");
      assert.equal(getRoleProfiles(db).length, 3);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lane_system_prompt_versions', 'lane_system_prompt_state', 'role_settings_history')").all(), []);
    } finally { db.close(); }
  });
});

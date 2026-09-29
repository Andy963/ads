import type { Database } from "better-sqlite3";

import { MODEL_SERVICES, type ModelService, type ModelServiceSelection } from "../../shared/modelServices.js";
import { createGlobalModelConfigStore } from "./globalModelConfigStore.js";
import { createModelProviderStore } from "./modelProviderStore.js";

export function createModelServiceStore(db: Database) {
  const models = createGlobalModelConfigStore(db);
  const providers = createModelProviderStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_service_members (
      service TEXT NOT NULL CHECK (service IN ('conversation', 'transcription', 'correction')),
      model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      PRIMARY KEY (service, model_config_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_default
      ON model_service_members(service) WHERE is_default = 1;
    CREATE TABLE IF NOT EXISTS model_services_initialized (id INTEGER PRIMARY KEY CHECK (id = 1));
  `);
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM model_services_initialized WHERE id = 1").get()) return;
    const existing = models.listModelConfigs().filter((model) => model.isEnabled);
    const selected = existing.find((model) => model.isDefault) ?? existing[0];
    const insert = db.prepare("INSERT OR IGNORE INTO model_service_members VALUES ('conversation', ?, ?)");
    for (const model of existing) insert.run(model.id, model.id === selected?.id ? 1 : 0);
    db.prepare("INSERT INTO model_services_initialized VALUES (1)").run();
  })();

  function get(service: ModelService): ModelServiceSelection {
    const rows = db.prepare("SELECT model_config_id, is_default FROM model_service_members WHERE service = ? ORDER BY model_config_id")
      .all(service) as Array<{ model_config_id: string; is_default: number }>;
    return { service, modelIds: rows.map((row) => row.model_config_id), defaultModelId: rows.find((row) => row.is_default)?.model_config_id ?? null };
  }

  function save(service: ModelService, modelIds: string[], defaultModelId: string | null): ModelServiceSelection {
    return db.transaction(() => {
      const ids = [...new Set(modelIds)];
      if (ids.length ? !defaultModelId || !ids.includes(defaultModelId) : defaultModelId !== null) {
        throw new Error("Select exactly one default from the enabled models, or disable all models.");
      }
      for (const id of ids) {
        const model = models.getModelConfig(id);
        if (!model) throw new Error("Unknown model configuration.");
        if (!model.isEnabled) throw new Error("The model is disabled in the catalog.");
        if (model.providerId && !providers.getProvider(model.providerId)?.isEnabled) throw new Error("The model provider is disabled or missing.");
        if (service !== "conversation" && !model.providerId) throw new Error("Attach the model to a provider first.");
      }
      db.prepare("DELETE FROM model_service_members WHERE service = ?").run(service);
      const insert = db.prepare("INSERT INTO model_service_members (service, model_config_id, is_default) VALUES (?, ?, ?)");
      for (const id of ids) insert.run(service, id, id === defaultModelId ? 1 : 0);
      return get(service);
    })();
  }

  function listModels(service: ModelService) {
    const selection = get(service);
    return models.listModelConfigs().filter((model) => selection.modelIds.includes(model.id) && model.isEnabled
      && (!model.providerId || providers.getProvider(model.providerId)?.isEnabled))
      .map((model) => ({ ...model, provider: model.providerId ? providers.getProvider(model.providerId)?.name ?? model.provider : model.provider,
        isDefault: model.id === selection.defaultModelId }));
  }

  function resolveDefault(service: ModelService) {
    const id = get(service).defaultModelId;
    const model = listModels(service).find((item) => item.id === id);
    if (!model) throw new Error(`Configure an enabled default model for ${service}.`);
    return model;
  }

  function resolveConversation(reference: string) {
    const available = listModels("conversation");
    const exact = available.find((model) => model.id === reference);
    if (exact) return exact;
    const legacy = available.filter((model) => model.modelId === reference);
    if (legacy.length === 1) return legacy[0];
    throw new Error("Select an enabled conversation model; the saved selection is unavailable or ambiguous.");
  }

  function removeModelReferences(modelId: string): void {
    db.transaction(() => {
      const model = models.getModelConfig(modelId);
      if (!model) return;
      for (const service of MODEL_SERVICES) {
        const selection = get(service);
        if (!selection.modelIds.includes(modelId)) continue;
        db.prepare("DELETE FROM model_service_members WHERE service = ? AND model_config_id = ?").run(service, modelId);
        if (selection.defaultModelId === modelId) {
          const next = listModels(service)[0]?.id ?? get(service).modelIds[0];
          if (next) db.prepare("UPDATE model_service_members SET is_default = 1 WHERE service = ? AND model_config_id = ?").run(service, next);
        }
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_profiles'").get()) {
        // Old profiles may still reference an upstream name. Only rewrite it
        // when that name uniquely identifies the model being removed.
        const legacyName = models.listModelConfigs().filter(item => item.modelId === model.modelId).length === 1 ? model.modelId : null;
        db.prepare(`UPDATE role_profiles SET model_id = ?, version = version + 1, updated_at = ?
          WHERE model_id = ? OR (? IS NOT NULL AND model_id = ?)`)
          .run(get("conversation").defaultModelId ?? "", Date.now(), modelId, legacyName, legacyName);
      }
    })();
  }

  return { get, list: () => MODEL_SERVICES.map(get), save, listModels, resolveDefault, resolveConversation, removeModelReferences };
}

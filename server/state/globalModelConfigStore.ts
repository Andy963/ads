import type { Database as DatabaseType } from "better-sqlite3";

import type { ModelConfig } from "../tasks/types.js";
import { modelConfigScopesOverlap } from "./modelConfigScope.js";

function parseJson(value: unknown): Record<string, unknown> | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toModelConfig(row: Record<string, unknown>): ModelConfig {
  const id = String(row.id ?? "");
  const modelId = String(row.model_id ?? "").trim() || id;
  return {
    id,
    modelId,
    displayName: String(row.display_name ?? ""),
    provider: String(row.provider ?? ""),
    isEnabled: Boolean(row.is_enabled),
    isDefault: Boolean(row.is_default),
    configJson: parseJson(row.config_json),
    updatedAt: toNullableNumber(row.updated_at),
  };
}

export function createGlobalModelConfigStore(db: DatabaseType) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY,
      model_id TEXT,
      display_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      config_json TEXT,
      updated_at INTEGER
    )
  `);
  const columns = db.prepare("PRAGMA table_info(model_configs)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "model_id")) {
    db.exec("ALTER TABLE model_configs ADD COLUMN model_id TEXT");
    db.exec("UPDATE model_configs SET model_id = id WHERE model_id IS NULL OR trim(model_id) = ''");
  }

  const listStmt = db.prepare("SELECT * FROM model_configs ORDER BY is_default DESC, updated_at DESC, display_name ASC");
  const getStmt = db.prepare("SELECT * FROM model_configs WHERE id = ? LIMIT 1");
  const getByModelIdStmt = db.prepare("SELECT * FROM model_configs WHERE model_id = ? LIMIT 1");
  const clearDefaultStmt = db.prepare("UPDATE model_configs SET is_default = 0 WHERE id = ?");
  const upsertStmt = db.prepare(`
    INSERT INTO model_configs (id, model_id, display_name, provider, is_enabled, is_default, config_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      model_id = excluded.model_id,
      display_name = excluded.display_name,
      provider = excluded.provider,
      is_enabled = excluded.is_enabled,
      is_default = excluded.is_default,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `);
  const deleteStmt = db.prepare("DELETE FROM model_configs WHERE id = ?");

  const listModelConfigs = (): ModelConfig[] => {
    const rows = listStmt.all() as Record<string, unknown>[];
    return rows.map((row) => toModelConfig(row));
  };

  const getModelConfig = (modelId: string): ModelConfig | null => {
    const id = String(modelId ?? "").trim();
    if (!id) return null;
    const row = getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? toModelConfig(row) : null;
  };

  const getModelConfigByAgentModelId = (agentModelId: string): ModelConfig | null => {
    const modelId = String(agentModelId ?? "").trim();
    if (!modelId) return null;
    const row = getByModelIdStmt.get(modelId) as Record<string, unknown> | undefined;
    return row ? toModelConfig(row) : null;
  };

  const upsertModelConfig = (config: ModelConfig, now = Date.now()): ModelConfig => {
    const id = String(config.id ?? "").trim();
    if (!id) throw new Error("model config id is required");
    const modelId = String(config.modelId ?? config.id ?? "").trim();
    if (!modelId) throw new Error("model config modelId is required");
    const displayName = String(config.displayName ?? "").trim() || modelId;
    const provider = String(config.provider ?? "").trim();
    if (!provider) throw new Error("model config provider is required");

    const tx = db.transaction(() => {
      if (config.isDefault) {
        const defaults = db.prepare("SELECT id, model_id, provider, config_json FROM model_configs WHERE is_default <> 0").all() as Array<Record<string, unknown>>;
        for (const row of defaults) {
          if (modelConfigScopesOverlap(config, {
            modelId: String(row.model_id ?? row.id ?? ""),
            provider: String(row.provider ?? ""),
            configJson: parseJson(row.config_json),
          })) {
            clearDefaultStmt.run(String(row.id ?? ""));
          }
        }
      }
      upsertStmt.run(
        id,
        modelId,
        displayName,
        provider,
        config.isEnabled ? 1 : 0,
        config.isDefault ? 1 : 0,
        config.configJson ? JSON.stringify(config.configJson) : null,
        now,
      );
    });
    tx();

    const saved = getModelConfig(id);
    if (!saved) throw new Error("failed to load saved model config");
    return saved;
  };

  const deleteModelConfig = (modelId: string): boolean => {
    const id = String(modelId ?? "").trim();
    if (!id) return false;
    const res = deleteStmt.run(id) as { changes?: number };
    return Number(res.changes ?? 0) > 0;
  };

  return { listModelConfigs, getModelConfig, getModelConfigByAgentModelId, upsertModelConfig, deleteModelConfig };
}

export type GlobalModelConfigStore = ReturnType<typeof createGlobalModelConfigStore>;

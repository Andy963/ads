import type { Database as DatabaseType } from "better-sqlite3";

import type { TaskStoreStatements } from "../storeStatements.js";
import type { ModelConfig } from "../types.js";

import { parseJson } from "./normalize.js";

export function createTaskStoreModelConfigOps(deps: { db: DatabaseType; stmts: TaskStoreStatements }) {
  const { db, stmts } = deps;

  const listModelConfigs = (): ModelConfig[] => {
    const rows = stmts.listModelConfigsStmt.all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      displayName: String(row.display_name ?? ""),
      provider: String(row.provider ?? ""),
      isEnabled: Boolean(row.is_enabled),
      isDefault: Boolean(row.is_default),
      configJson: parseJson<Record<string, unknown>>(row.config_json) ?? null,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : row.updated_at == null ? null : Number(row.updated_at),
    }));
  };

  const getModelConfig = (modelId: string): ModelConfig | null => {
    const id = String(modelId ?? "").trim();
    if (!id) {
      return null;
    }
    const row = stmts.getModelConfigStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.id ?? ""),
      displayName: String(row.display_name ?? ""),
      provider: String(row.provider ?? ""),
      isEnabled: Boolean(row.is_enabled),
      isDefault: Boolean(row.is_default),
      configJson: parseJson<Record<string, unknown>>(row.config_json) ?? null,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : row.updated_at == null ? null : Number(row.updated_at),
    };
  };

  const upsertModelConfig = (config: ModelConfig, now = Date.now()): ModelConfig => {
    const id = String(config.id ?? "").trim();
    if (!id) {
      throw new Error("model config id is required");
    }
    const displayName = String(config.displayName ?? "").trim();
    if (!displayName) {
      throw new Error("model config displayName is required");
    }
    const provider = String(config.provider ?? "").trim();
    if (!provider) {
      throw new Error("model config provider is required");
    }

    const isEnabled = Boolean(config.isEnabled);
    const isDefault = Boolean(config.isDefault);
    const configJson = config.configJson ?? null;
    const configJsonText = configJson ? JSON.stringify(configJson) : null;

    const tx = db.transaction(() => {
      if (isDefault) {
        stmts.clearDefaultModelConfigsStmt.run();
      }
      stmts.upsertModelConfigStmt.run(id, displayName, provider, isEnabled ? 1 : 0, isDefault ? 1 : 0, configJsonText, now);
    });
    tx();

    const saved = getModelConfig(id);
    if (!saved) {
      throw new Error("failed to load saved model config");
    }
    return saved;
  };

  const deleteModelConfig = (modelId: string): boolean => {
    const id = String(modelId ?? "").trim();
    if (!id) {
      return false;
    }
    const res = stmts.deleteModelConfigStmt.run(id) as { changes?: number };
    return Number(res.changes ?? 0) > 0;
  };

  return { listModelConfigs, getModelConfig, upsertModelConfig, deleteModelConfig };
}


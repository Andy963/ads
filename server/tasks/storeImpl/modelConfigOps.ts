import type { Database as DatabaseType } from "better-sqlite3";

import type { TaskStoreStatements } from "../storeStatements.js";
import type { ModelConfig } from "../types.js";

import { toModelConfig } from "./mappers.js";
import { modelConfigScopesOverlap } from "../../state/modelConfigScope.js";

function parseConfigJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createTaskStoreModelConfigOps(deps: { db: DatabaseType; stmts: TaskStoreStatements }) {
  const { db, stmts } = deps;

  const listModelConfigs = (): ModelConfig[] => {
    const rows = stmts.listModelConfigsStmt.all() as Record<string, unknown>[];
    return rows.map((row) => toModelConfig(row));
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
    return toModelConfig(row);
  };

  const upsertModelConfig = (config: ModelConfig, now = Date.now()): ModelConfig => {
    const id = String(config.id ?? "").trim();
    if (!id) {
      throw new Error("model config id is required");
    }
    const modelId = String(config.modelId ?? config.id ?? "").trim();
    if (!modelId) {
      throw new Error("model config modelId is required");
    }
    const displayName = String(config.displayName ?? "").trim() || modelId;
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
        const defaults = db
          .prepare("SELECT id, model_id, provider, config_json FROM model_configs WHERE is_default <> 0")
          .all() as Array<Record<string, unknown>>;
        for (const row of defaults) {
          if (modelConfigScopesOverlap(config, {
            modelId: String(row.model_id ?? row.id ?? ""),
            provider: String(row.provider ?? ""),
            configJson: parseConfigJson(row.config_json),
          })) {
            db.prepare("UPDATE model_configs SET is_default = 0 WHERE id = ?").run(String(row.id ?? ""));
          }
        }
      }
      stmts.upsertModelConfigStmt.run(
        id,
        modelId,
        displayName,
        provider,
        isEnabled ? 1 : 0,
        isDefault ? 1 : 0,
        configJsonText,
        now,
      );
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

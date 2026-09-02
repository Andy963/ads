import type { Database as DatabaseType } from "better-sqlite3";

import type { AgentIdentifier } from "../agents/types.js";
import { selectAgentForModel } from "../tasks/agentSelection.js";
import type { ModelConfig, ReviewerModelSelection } from "../tasks/types.js";
import { createGlobalModelConfigStore, type GlobalModelConfigStore } from "./globalModelConfigStore.js";

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function isConcreteModel(model: ModelConfig | null | undefined): model is ModelConfig & { modelId: string } {
  const modelId = normalizeString(model?.modelId ?? model?.id);
  return Boolean(model && model.isEnabled && modelId && modelId.toLowerCase() !== "auto");
}

function resolveReviewerAgent(model: ModelConfig, modelId: string): AgentIdentifier {
  const allowedAgents = model.configJson?.allowedAgents;
  if (Array.isArray(allowedAgents)) {
    const configuredAgent = allowedAgents.map((value) => normalizeString(value)).find(Boolean);
    if (configuredAgent) return configuredAgent;
  }
  return selectAgentForModel(modelId);
}

export function createReviewerModelStore(
  db: DatabaseType,
  modelStore: GlobalModelConfigStore = createGlobalModelConfigStore(db),
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviewer_model_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model_config_id TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  const getSelectionStmt = db.prepare("SELECT model_config_id AS modelConfigId FROM reviewer_model_settings WHERE id = 1");
  const setSelectionStmt = db.prepare(`
    INSERT INTO reviewer_model_settings (id, model_config_id, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      model_config_id = excluded.model_config_id,
      updated_at = excluded.updated_at
  `);

  const getReviewerModelConfigId = (): string | null => {
    const row = getSelectionStmt.get() as { modelConfigId?: unknown } | undefined;
    const modelConfigId = normalizeString(row?.modelConfigId);
    return modelConfigId || null;
  };

  const getConfiguredReviewerModel = (): ReviewerModelSelection | null => {
    const modelConfigId = getReviewerModelConfigId();
    if (!modelConfigId) return null;
    const model = modelStore.getModelConfig(modelConfigId);
    if (!isConcreteModel(model)) return null;
    const modelId = normalizeString(model.modelId ?? model.id);
    return {
      model: modelId,
      agentId: resolveReviewerAgent(model, modelId),
      modelConfigId,
    };
  };

  const setReviewerModel = (modelConfigId: string | null, now = Date.now()): ReviewerModelSelection | null => {
    const normalizedId = modelConfigId == null ? null : normalizeString(modelConfigId);
    if (normalizedId) {
      const model = modelStore.getModelConfig(normalizedId);
      if (!isConcreteModel(model)) {
        throw new Error("Reviewer model must be an enabled concrete model");
      }
    }
    setSelectionStmt.run(normalizedId, now);
    return getConfiguredReviewerModel();
  };

  return { getReviewerModelConfigId, getConfiguredReviewerModel, setReviewerModel };
}

export type ReviewerModelStore = ReturnType<typeof createReviewerModelStore>;

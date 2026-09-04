import { z } from "zod";
import { randomUUID } from "node:crypto";

import { getStateDatabase } from "../../../../state/database.js";
import { createGlobalModelConfigStore, type GlobalModelConfigStore } from "../../../../state/globalModelConfigStore.js";
import type { ModelConfig } from "../../../../tasks/types.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

const trimmedNonEmptyString = z.string().trim().min(1);

const modelConfigFieldsSchema = {
  modelId: trimmedNonEmptyString.optional(),
  displayName: z.string().trim().optional(),
  provider: trimmedNonEmptyString,
  isEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  configJson: z.record(z.unknown()).nullable().optional(),
} as const;

const createModelConfigSchema = z
  .object({
    ...modelConfigFieldsSchema,
    modelId: trimmedNonEmptyString,
  })
  .passthrough();

const updateModelConfigSchema = z
  .object({
    modelId: modelConfigFieldsSchema.modelId,
    displayName: modelConfigFieldsSchema.displayName.optional(),
    provider: modelConfigFieldsSchema.provider.optional(),
    isEnabled: modelConfigFieldsSchema.isEnabled,
    isDefault: modelConfigFieldsSchema.isDefault,
    configJson: modelConfigFieldsSchema.configJson,
  })
  .passthrough();

type CreateModelConfigInput = z.infer<typeof createModelConfigSchema>;
type UpdateModelConfigInput = z.infer<typeof updateModelConfigSchema>;

type ModelRouteDeps = {
  modelStore?: GlobalModelConfigStore;
};

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeModelConfigId(value: unknown): string | null {
  const id = normalizeString(value);
  if (!id || id.toLowerCase() === "auto") {
    return null;
  }
  return id;
}

function createModelConfigId(): string {
  return `model-${randomUUID()}`;
}

function buildModelConfigPayload(
  modelId: string,
  input: CreateModelConfigInput | UpdateModelConfigInput,
  existing?: ModelConfig,
): ModelConfig {
  const agentModelId = normalizeModelConfigId(input.modelId ?? existing?.modelId ?? modelId) ?? modelId;
  const displayName = normalizeString(input.displayName ?? existing?.displayName) || agentModelId;
  return {
    id: modelId,
    modelId: agentModelId,
    displayName,
    provider: input.provider ?? existing?.provider ?? "",
    isEnabled: input.isEnabled ?? existing?.isEnabled ?? true,
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    configJson: input.configJson === undefined ? (existing?.configJson ?? null) : input.configJson,
  };
}

export async function handleModelRoutes(ctx: ApiRouteContext, deps: ModelRouteDeps = {}): Promise<boolean> {
  const { req, res, pathname } = ctx;
  const getModelStore = () => deps.modelStore ?? createGlobalModelConfigStore(getStateDatabase());

  if (req.method === "GET" && pathname === "/api/models") {
    const modelStore = getModelStore();
    const configured = modelStore.listModelConfigs();
    sendJson(res, 200, configured.filter((model) => model.isEnabled));
    return true;
  }

  if (pathname === "/api/model-configs") {
    const modelStore = getModelStore();
    if (req.method === "GET") {
      sendJson(res, 200, modelStore.listModelConfigs());
      return true;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const parsed = createModelConfigSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      const agentModelId = normalizeModelConfigId(parsed.data.modelId);
      if (!agentModelId) {
        sendJson(res, 400, { error: "Invalid model id" });
        return true;
      }
      const existing = modelStore.getModelConfigByAgentModelId(agentModelId);
      const saved = modelStore.upsertModelConfig(
        buildModelConfigPayload(existing?.id ?? createModelConfigId(), parsed.data, existing ?? undefined),
      );
      sendJson(res, 200, saved);
      return true;
    }
    return false;
  }

  const modelConfigMatch = /^\/api\/model-configs\/([^/]+)$/.exec(pathname);
  if (modelConfigMatch?.[1]) {
    let modelId: string;
    try {
      modelId = decodeURIComponent(modelConfigMatch[1]).trim();
    } catch {
      modelId = String(modelConfigMatch[1]).trim();
    }
    const modelStore = getModelStore();

    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const parsed = updateModelConfigSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }

      const existing = modelStore.getModelConfig(modelId);
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      const agentModelId = normalizeModelConfigId(parsed.data.modelId);
      if (parsed.data.modelId !== undefined && !agentModelId) {
        sendJson(res, 400, { error: "Invalid model id" });
        return true;
      }
      if (agentModelId) {
        const conflict = modelStore.getModelConfigByAgentModelId(agentModelId);
        if (conflict && conflict.id !== modelId) {
          sendJson(res, 409, { error: "Model ID already exists" });
          return true;
        }
      }

      const saved = modelStore.upsertModelConfig(buildModelConfigPayload(modelId, parsed.data, existing));
      sendJson(res, 200, saved);
      return true;
    }

    if (req.method === "DELETE") {
      const existing = modelStore.getModelConfig(modelId);
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      if (existing.isDefault) {
        sendJson(res, 400, { error: "Cannot delete default model" });
        return true;
      }
      const deleted = modelStore.deleteModelConfig(modelId);
      sendJson(res, 200, { success: deleted });
      return true;
    }
  }

  return false;
}

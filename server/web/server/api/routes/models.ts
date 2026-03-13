import { z } from "zod";

import type { ModelConfig } from "../../../../tasks/types.js";
import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

const trimmedNonEmptyString = z.string().trim().min(1);

const modelConfigFieldsSchema = {
  displayName: trimmedNonEmptyString,
  provider: trimmedNonEmptyString,
  isEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  configJson: z.record(z.unknown()).nullable().optional(),
} as const;

const createModelConfigSchema = z
  .object({
    id: trimmedNonEmptyString,
    ...modelConfigFieldsSchema,
  })
  .passthrough();

const updateModelConfigSchema = z
  .object({
    displayName: modelConfigFieldsSchema.displayName.optional(),
    provider: modelConfigFieldsSchema.provider.optional(),
    isEnabled: modelConfigFieldsSchema.isEnabled,
    isDefault: modelConfigFieldsSchema.isDefault,
    configJson: modelConfigFieldsSchema.configJson,
  })
  .passthrough();

type CreateModelConfigInput = z.infer<typeof createModelConfigSchema>;
type UpdateModelConfigInput = z.infer<typeof updateModelConfigSchema>;

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

function buildModelConfigPayload(
  modelId: string,
  input: CreateModelConfigInput | UpdateModelConfigInput,
  existing?: ModelConfig,
): ModelConfig {
  return {
    id: modelId,
    displayName: input.displayName ?? existing?.displayName ?? "",
    provider: input.provider ?? existing?.provider ?? "",
    isEnabled: input.isEnabled ?? existing?.isEnabled ?? true,
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    configJson: input.configJson === undefined ? (existing?.configJson ?? null) : input.configJson,
  };
}

export async function handleModelRoutes(ctx: ApiRouteContext, deps: Pick<ApiSharedDeps, "resolveTaskContext">): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method === "GET" && pathname === "/api/models") {
    const taskCtx = deps.resolveTaskContext(url);
    const models = taskCtx.taskStore.listModelConfigs().filter((m) => m.isEnabled);
    sendJson(res, 200, models);
    return true;
  }

  if (pathname === "/api/model-configs") {
    const taskCtx = deps.resolveTaskContext(url);
    if (req.method === "GET") {
      sendJson(res, 200, taskCtx.taskStore.listModelConfigs());
      return true;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const parsed = createModelConfigSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      const modelId = normalizeModelConfigId(parsed.data.id);
      if (!modelId) {
        sendJson(res, 400, { error: "Invalid model id" });
        return true;
      }
      const saved = taskCtx.taskStore.upsertModelConfig(buildModelConfigPayload(modelId, parsed.data));
      sendJson(res, 200, saved);
      return true;
    }
    return false;
  }

  const modelConfigMatch = /^\/api\/model-configs\/([^/]+)$/.exec(pathname);
  if (modelConfigMatch?.[1]) {
    const modelId = String(modelConfigMatch[1]).trim();
    const taskCtx = deps.resolveTaskContext(url);

    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const parsed = updateModelConfigSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }

      const existing = taskCtx.taskStore.getModelConfig(modelId);
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }

      const saved = taskCtx.taskStore.upsertModelConfig(buildModelConfigPayload(modelId, parsed.data, existing));
      sendJson(res, 200, saved);
      return true;
    }

    if (req.method === "DELETE") {
      const existing = taskCtx.taskStore.getModelConfig(modelId);
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      if (existing.isDefault) {
        sendJson(res, 400, { error: "Cannot delete default model" });
        return true;
      }
      const deleted = taskCtx.taskStore.deleteModelConfig(modelId);
      sendJson(res, 200, { success: deleted });
      return true;
    }
  }

  return false;
}

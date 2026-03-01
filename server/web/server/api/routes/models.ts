import { z } from "zod";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

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
      const schema = z
        .object({
          id: z.string().min(1),
          displayName: z.string().min(1),
          provider: z.string().min(1),
          isEnabled: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          configJson: z.record(z.unknown()).nullable().optional(),
        })
        .passthrough();
      const parsed = schema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      const modelId = parsed.data.id.trim();
      if (!modelId || modelId.toLowerCase() === "auto") {
        sendJson(res, 400, { error: "Invalid model id" });
        return true;
      }
      const saved = taskCtx.taskStore.upsertModelConfig({
        id: modelId,
        displayName: parsed.data.displayName.trim(),
        provider: parsed.data.provider.trim(),
        isEnabled: parsed.data.isEnabled ?? true,
        isDefault: parsed.data.isDefault ?? false,
        configJson: parsed.data.configJson ?? null,
      });
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
      const schema = z
        .object({
          displayName: z.string().min(1).optional(),
          provider: z.string().min(1).optional(),
          isEnabled: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          configJson: z.record(z.unknown()).nullable().optional(),
        })
        .passthrough();
      const parsed = schema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }

      const existing = taskCtx.taskStore.getModelConfig(modelId);
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }

      const saved = taskCtx.taskStore.upsertModelConfig({
        ...existing,
        displayName: parsed.data.displayName === undefined ? existing.displayName : parsed.data.displayName.trim(),
        provider: parsed.data.provider === undefined ? existing.provider : parsed.data.provider.trim(),
        isEnabled: parsed.data.isEnabled === undefined ? existing.isEnabled : parsed.data.isEnabled,
        isDefault: parsed.data.isDefault === undefined ? existing.isDefault : parsed.data.isDefault,
        configJson: parsed.data.configJson === undefined ? (existing.configJson ?? null) : parsed.data.configJson,
      });
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


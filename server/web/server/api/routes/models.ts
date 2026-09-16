import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

import { getStateDatabase } from "../../../../state/database.js";
import { createGlobalModelConfigStore, type GlobalModelConfigStore } from "../../../../state/globalModelConfigStore.js";
import type { ModelConfig } from "../../../../state/modelConfigTypes.js";
import { resolveCodexConfig, type CodexOverrides, type CodexResolvedConfig } from "../../../../codexConfig.js";
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
  resolveConfig?: (overrides?: CodexOverrides) => CodexResolvedConfig;
  fetchImpl?: typeof fetch;
};

const upstreamDiscoverySchema = z
  .object({
    baseUrl: z.string().trim().url().optional(),
    apiKey: trimmedNonEmptyString.optional(),
  })
  .strict();

const UPSTREAM_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_MODELS_TIMEOUT_MS = 5000;

type UpstreamDiscoveryResult = {
  ok: boolean;
  models: string[];
  error?: string;
};

type UpstreamModelsCacheEntry = {
  expiresAt: number;
  models: string[];
};

const upstreamModelsCache = new Map<string, UpstreamModelsCacheEntry>();

export function resetUpstreamModelsCache(): void {
  upstreamModelsCache.clear();
}

function getUpstreamError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildModelsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Upstream base URL must not contain credentials");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getUpstreamCacheKey(endpoint: string, apiKey: string): string {
  const keyFingerprint = createHash("sha256").update(apiKey).digest("hex");
  return `${endpoint}\u0000${keyFingerprint}`;
}

function parseUpstreamModels(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    return null;
  }
  const models = (body as { data: unknown[] }).data
    .map((entry) => {
      if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") {
        return null;
      }
      const modelId = (entry as { id: string }).id.trim();
      return modelId || null;
    })
    .filter((modelId): modelId is string => modelId !== null);
  return [...new Set(models)].sort();
}

function getCachedUpstreamModels(cacheKey: string, now: number): string[] | null {
  const cached = upstreamModelsCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    upstreamModelsCache.delete(cacheKey);
    return null;
  }
  return cached.models;
}

async function loadUpstreamModels(
  deps: ModelRouteDeps,
  overrides: CodexOverrides = {},
): Promise<UpstreamDiscoveryResult> {
  const now = Date.now();

  let config: CodexResolvedConfig;
  try {
    config = (deps.resolveConfig ?? resolveCodexConfig)(overrides);
  } catch (err) {
    return { ok: false, models: [], error: getUpstreamError(err) };
  }
  if (!config.baseUrl || !config.apiKey) {
    return { ok: false, models: [], error: "Upstream model discovery requires an API key and base URL" };
  }

  let endpoint: string;
  try {
    endpoint = buildModelsEndpoint(config.baseUrl);
  } catch (err) {
    return { ok: false, models: [], error: getUpstreamError(err) };
  }
  const cacheKey = getUpstreamCacheKey(endpoint, config.apiKey);
  const cachedModels = getCachedUpstreamModels(cacheKey, now);
  if (cachedModels) {
    return { ok: true, models: cachedModels };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(UPSTREAM_MODELS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, models: [], error: `Upstream model endpoint returned HTTP ${response.status}` };
    }
    const models = parseUpstreamModels(await response.json());
    if (!models) {
      return { ok: false, models: [], error: "Invalid upstream model response" };
    }
    upstreamModelsCache.set(cacheKey, { expiresAt: now + UPSTREAM_MODELS_CACHE_TTL_MS, models });
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: getUpstreamError(err) };
  }
}

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

  if (req.method === "POST" && (pathname === "/api/models/upstream" || pathname === "/api/models/upstream/discover")) {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, models: [], error: "Invalid JSON payload" });
      return true;
    }
    const parsed = upstreamDiscoverySchema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { ok: false, models: [], error: "Invalid upstream discovery payload" });
      return true;
    }
    sendJson(res, 200, await loadUpstreamModels(deps, parsed.data));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/models/upstream") {
    sendJson(res, 200, await loadUpstreamModels(deps));
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

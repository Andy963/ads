import { resolveCodexConfig } from "../codexConfig.js";
import { createGlobalModelConfigStore } from "../state/globalModelConfigStore.js";
import { normalizeConfiguredReasoningEffort } from "../state/modelConfigTypes.js";
import { createUpstreamCredentialStore } from "../state/upstreamCredentialStore.js";
import { getStateDatabase } from "../state/database.js";
import { normalizeUpstreamBaseUrl } from "../utils/upstreamUrl.js";
import {
  resolveNativeProviderCapabilities,
  type NativeProviderCapabilities,
} from "./nativeProviderCapabilities.js";

export interface NativeModelRequestOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: string;
}

export interface NativeModelConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  contextWindow?: number;
  capabilities?: Partial<NativeProviderCapabilities>;
  options?: NativeModelRequestOptions;
  supportsReasoningEffort?: boolean;
}

export interface NativeModelResolver {
  resolve(model?: string, overrideConfig?: Record<string, unknown> | null): NativeModelConfig;
}

type ResolverOptions = {
  owner: string;
  stateDbPath?: string;
  env?: NodeJS.ProcessEnv;
};

function readString(config: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = config?.[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readFiniteNumber(
  config: Record<string, unknown> | null | undefined,
  key: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const value = Number(config?.[key]);
  if (!Number.isFinite(value)) return undefined;
  if (options.integer && !Number.isInteger(value)) return undefined;
  if (options.min !== undefined && value < options.min) return undefined;
  if (options.max !== undefined && value > options.max) return undefined;
  return value;
}

function readBoolean(config: Record<string, unknown> | null | undefined, key: string): boolean | undefined {
  const value = config?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function hasConfiguredReasoningEfforts(config: Record<string, unknown> | null | undefined): boolean | undefined {
  const raw = config?.reasoningEfforts;
  if (!Array.isArray(raw)) return undefined;
  return raw.some((entry) => String(entry ?? "").trim().length > 0);
}

function inferReasoningEffortSupport(
  config: Record<string, unknown> | null | undefined,
  model: string,
): boolean {
  const explicit = readBoolean(config, "supportsReasoningEffort") ?? readBoolean(config, "reasoningEffortSupported");
  if (explicit !== undefined) return explicit;

  const configured = hasConfiguredReasoningEfforts(config);
  if (configured !== undefined) return configured;

  return /(?:^|[/_:-])(?:o[134](?:$|[._:-])|gpt-5(?:$|[._:-])|deepseek-(?:reasoner|r1)(?:$|[._:-])|qwq(?:$|[._:-])|qwen[^/]*thinking(?:$|[._:-]))/i.test(model);
}

function requestOptions(config: Record<string, unknown> | null | undefined): NativeModelRequestOptions | undefined {
  const temperature = readFiniteNumber(config, "temperature", { min: 0, max: 2 });
  const topP = readFiniteNumber(config, "topP", { min: 0, max: 1 });
  const maxTokens = readFiniteNumber(config, "maxTokens", { min: 1, max: 1_000_000, integer: true });
  const reasoningEffort = normalizeConfiguredReasoningEffort(config?.reasoningEffort);
  if (temperature === undefined && topP === undefined && maxTokens === undefined && reasoningEffort === undefined) {
    return undefined;
  }
  const options: NativeModelRequestOptions = {};
  if (temperature !== undefined) options.temperature = temperature;
  if (topP !== undefined) options.topP = topP;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
  return options;
}

function contextWindow(config: Record<string, unknown> | null | undefined): number | undefined {
  for (const key of [
    "contextWindow",
    "context_window",
    "modelContextWindow",
    "model_context_window",
    "maxContextTokens",
    "max_context_tokens",
  ]) {
    const value = Number(config?.[key]);
    if (Number.isSafeInteger(value) && value >= 256 && value <= 100_000_000) {
      return value;
    }
  }
  return undefined;
}

function resolveSavedModelConfig(
  model: string,
  overrideConfig: Record<string, unknown> | null | undefined,
  stateDbPath: string | undefined,
  owner: string,
  env: NodeJS.ProcessEnv,
): NativeModelConfig | null {
  const db = getStateDatabase(stateDbPath);
  const modelStore = createGlobalModelConfigStore(db);
  const saved = modelStore.getModelConfigByAgentModelId(model) ?? modelStore.getModelConfig(model);
  if (!saved) return null;
  if (!saved.isEnabled) {
    throw new Error(`Native runtime model "${saved.modelId ?? model}" is disabled`);
  }

  const config = overrideConfig ?? saved.configJson ?? null;
  const profile = readString(config, "credentialProfile");
  const credentialStore = createUpstreamCredentialStore(db, { pepper: env.ADS_WEB_SESSION_PEPPER ?? "" });
  const credentials = credentialStore.getCredentials(owner, profile);
  const configuredBaseUrl = readString(config, "baseUrl");
  const savedProvider = String(saved.provider ?? "").trim();
  let baseUrl: string;
  let apiKey: string;
  if (credentials) {
    if (credentials.provider.trim().toLowerCase() !== savedProvider.toLowerCase()) {
      throw new Error("Native runtime credential profile does not match the model provider");
    }
    baseUrl = normalizeUpstreamBaseUrl(configuredBaseUrl ?? credentials.baseUrl);
    if (baseUrl !== normalizeUpstreamBaseUrl(credentials.baseUrl)) {
      throw new Error("Native runtime model endpoint does not match the selected encrypted credential profile");
    }
    apiKey = credentials.apiKey;
  } else {
    // The built-in OpenAI model rows predate encrypted credential profiles and
    // must remain usable with the existing server-side Codex environment.
    // Other providers fail closed instead of borrowing another provider's key.
    if (profile || !["openai", "codex"].includes(savedProvider.toLowerCase())) {
      throw new Error(`Native runtime credentials are not configured for model "${saved.modelId ?? model}"`);
    }
    let fallback: ReturnType<typeof resolveCodexConfig>;
    try {
      fallback = resolveCodexConfig({}, env);
    } catch {
      throw new Error(`Native runtime credentials are not configured for model "${saved.modelId ?? model}"`);
    }
    if (!fallback.apiKey || !fallback.baseUrl) {
      throw new Error(`Native runtime credentials are not configured for model "${saved.modelId ?? model}"`);
    }
    baseUrl = normalizeUpstreamBaseUrl(configuredBaseUrl ?? fallback.baseUrl);
    if (configuredBaseUrl && baseUrl !== normalizeUpstreamBaseUrl(fallback.baseUrl)) {
      throw new Error("Native runtime model endpoint does not match the configured Codex endpoint");
    }
    apiKey = fallback.apiKey;
  }

  const resolvedContextWindow = contextWindow(config);
  const capabilities = resolveNativeProviderCapabilities(config);
  const hasExplicitCapabilities = config && (
    "capabilities" in config
    || "supportsStructuredOutput" in config
    || "structuredOutput" in config
    || "supportsReasoningEffort" in config
    || "reasoningEffortSupported" in config
    || "supportsImageInput" in config
    || "imageInput" in config
    || "providerOptions" in config
    || "supportsProviderOptions" in config
  );
  return {
    model: String(saved.modelId ?? model).trim() || model,
    baseUrl,
    apiKey,
    provider: savedProvider || (credentials?.provider ?? "openai"),
    options: requestOptions(config),
    ...(resolvedContextWindow ? { contextWindow: resolvedContextWindow } : {}),
    ...(hasExplicitCapabilities ? { capabilities } : {}),
    ...(inferReasoningEffortSupport(config, String(saved.modelId ?? model).trim() || model)
      ? { supportsReasoningEffort: true }
      : {}),
  };
}

export function createNativeModelResolver(options: ResolverOptions): NativeModelResolver {
  const env = options.env ?? process.env;
  const owner = String(options.owner ?? "").trim();
  if (!owner) throw new Error("Native runtime requires an authenticated credential owner");

  return {
    resolve(model = "default", overrideConfig = null): NativeModelConfig {
      const modelId = String(model ?? "default").trim() || "default";
      const saved = resolveSavedModelConfig(modelId, overrideConfig, options.stateDbPath, owner, env);
      if (saved) return saved;

      const fallback = resolveCodexConfig({}, env);
      if (!fallback.apiKey || !fallback.baseUrl) {
        throw new Error("Native runtime requires an API key and HTTP base URL");
      }
      return {
        model: modelId,
        baseUrl: normalizeUpstreamBaseUrl(fallback.baseUrl),
        apiKey: fallback.apiKey,
        provider: "openai",
        options: {
          reasoningEffort: fallback.modelReasoningEffort,
        },
        ...(inferReasoningEffortSupport(null, modelId) ? { supportsReasoningEffort: true } : {}),
      };
    },
  };
}

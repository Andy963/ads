import { resolveCodexConfig } from "../codexConfig.js";
import { createGlobalModelConfigStore } from "../state/globalModelConfigStore.js";
import { createModelServiceStore } from "../state/modelServiceStore.js";
import { createModelProviderStore } from "../state/modelProviderStore.js";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeConfiguredReasoningEffort,
} from "../state/modelConfigTypes.js";
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
}

export interface NativeModelResolver {
  resolve(model?: string, overrideConfig?: Record<string, unknown> | null): NativeModelConfig;
}

type ResolverOptions = {
  owner: string;
  requireOwnerCredentials?: boolean;
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

function requestOptions(config: Record<string, unknown> | null | undefined): NativeModelRequestOptions | undefined {
  const temperature = readFiniteNumber(config, "temperature", { min: 0, max: 2 });
  const topP = readFiniteNumber(config, "topP", { min: 0, max: 1 });
  const maxTokens = readFiniteNumber(config, "maxTokens", { min: 1, max: 1_000_000, integer: true });
  const reasoningEffort = normalizeConfiguredReasoningEffort(config?.reasoningEffort) ?? DEFAULT_REASONING_EFFORT;
  if (temperature === undefined && topP === undefined && maxTokens === undefined) {
    return { reasoningEffort };
  }
  const options: NativeModelRequestOptions = { reasoningEffort };
  if (temperature !== undefined) options.temperature = temperature;
  if (topP !== undefined) options.topP = topP;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
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
  requireOwnerCredentials: boolean,
): NativeModelConfig | null {
  const db = getStateDatabase(stateDbPath);
  const modelStore = createGlobalModelConfigStore(db);
  const saved = modelStore.getModelConfig(model) ?? modelStore.getModelConfigByAgentModelId(model);
  if (!saved) return null;
  if (!saved.isEnabled) {
    throw new Error(`Native runtime model "${saved.modelId ?? model}" is disabled`);
  }

  const config = overrideConfig ?? saved.configJson ?? null;
  // A first-class provider attachment overrides the free-form credential
  // profile and base URL carried by the model config.
  const providerId = String(saved.providerId ?? "").trim();
  const attachedProvider = providerId ? createModelProviderStore(db).getProvider(providerId) : null;
  if (providerId && !attachedProvider) {
    throw new Error(`Native runtime model "${saved.modelId ?? model}" references an unknown provider`);
  }
  if (attachedProvider && !attachedProvider.isEnabled) {
    throw new Error(`Native runtime provider "${attachedProvider.name}" is disabled`);
  }
  const wireApi = String(attachedProvider?.wireApi ?? "").trim();
  if (wireApi && wireApi !== "chat") {
    throw new Error("Native runtime supports only Chat Completions; select Chat completions in the provider API format.");
  }
  createModelServiceStore(db).resolveConversation(saved.id);
  const profile = attachedProvider
    ? String(attachedProvider.credentialProfile ?? "").trim() || attachedProvider.id
    : readString(config, "credentialProfile");
  const credentialStore = createUpstreamCredentialStore(db, { pepper: env.ADS_WEB_SESSION_PEPPER ?? "" });
  const credentials = credentialStore.getCredentials(owner, profile);
  const configuredBaseUrl = attachedProvider?.baseUrl ?? readString(config, "baseUrl");
  const savedProvider = String(saved.provider ?? "").trim();
  let baseUrl: string;
  let apiKey: string;
  if (credentials) {
    const credentialProvider = credentials.provider.trim().toLowerCase();
    const acceptedProviders = [savedProvider, attachedProvider?.name ?? "", attachedProvider?.id ?? ""].map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (acceptedProviders.length > 0 && !acceptedProviders.includes(credentialProvider)) {
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
    if (requireOwnerCredentials || profile || !["openai", "codex"].includes(savedProvider.toLowerCase())) {
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
    || "streaming" in config
    || "nonStreaming" in config
    || "toolCalls" in config
    || "parallelToolCalls" in config
    || "usage" in config
    || "contextMetadata" in config
    || "supportsStructuredOutput" in config
    || "structuredOutput" in config
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
  };
}

export function createNativeModelResolver(options: ResolverOptions): NativeModelResolver {
  const env = options.env ?? process.env;
  const owner = String(options.owner ?? "").trim();
  if (!owner) throw new Error("Native runtime requires an authenticated credential owner");

  return {
    resolve(model = "default", overrideConfig = null): NativeModelConfig {
      const modelId = String(model ?? "default").trim() || "default";
      const saved = resolveSavedModelConfig(modelId, overrideConfig, options.stateDbPath, owner, env, options.requireOwnerCredentials ?? false);
      if (saved) return saved;
      if (options.requireOwnerCredentials) throw new Error("Reviewer requires a saved model and owner-scoped credentials");

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
          reasoningEffort: fallback.modelReasoningEffort ?? DEFAULT_REASONING_EFFORT,
        },
      };
    },
  };
}

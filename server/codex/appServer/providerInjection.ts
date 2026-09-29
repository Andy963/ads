import type { Database } from "better-sqlite3";

import { createGlobalModelConfigStore } from "../../state/globalModelConfigStore.js";
import { createModelProviderStore, type ModelProvider } from "../../state/modelProviderStore.js";
import { createUpstreamCredentialStore } from "../../state/upstreamCredentialStore.js";

/**
 * Name of the environment variable that carries the selected provider's API
 * key into the spawned `codex app-server` process. The secret is only ever
 * present in the child process environment — never in argv, where it would be
 * visible in process listings.
 */
export const CODEX_PROVIDER_API_KEY_ENV = "ADS_CODEX_PROVIDER_API_KEY";

export interface CodexProviderInjection {
  /** `-c` config overrides inserted before the `app-server` subcommand. */
  globalArgs: string[];
  /** Extra environment for the spawned daemon; carries the decrypted secret. */
  env: NodeJS.ProcessEnv;
  /** Stable identifier of the injected provider (safe to log). */
  providerId: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Slug used as the codex `model_providers.<slug>` table key. Derived from the
 * provider id so it is stable across restarts and free of TOML-hostile chars.
 */
export function codexProviderSlug(providerId: string): string {
  const slug = providerId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ads-${slug || "provider"}`;
}

export function buildCodexProviderInjection(args: {
  provider: ModelProvider;
  apiKey: string;
}): CodexProviderInjection {
  const { provider } = args;
  const slug = codexProviderSlug(provider.id);
  const wireApi = String(provider.wireApi ?? "").trim() || "responses";
  return {
    providerId: provider.id,
    globalArgs: [
      "-c", `model_providers.${slug}.name=${tomlString(provider.name)}`,
      "-c", `model_providers.${slug}.base_url=${tomlString(provider.baseUrl)}`,
      "-c", `model_providers.${slug}.env_key=${tomlString(CODEX_PROVIDER_API_KEY_ENV)}`,
      "-c", `model_providers.${slug}.wire_api=${tomlString(wireApi)}`,
      "-c", `model_provider=${tomlString(slug)}`,
    ],
    env: { [CODEX_PROVIDER_API_KEY_ENV]: args.apiKey },
  };
}

/**
 * Resolve the provider attached to a conversation model and decrypt its
 * credential at call time. Returns null when the model has no provider
 * attached; throws when a provider is attached but unusable.
 */
export function resolveCodexProviderInjection(args: {
  db: Database;
  owner: string;
  model?: string | null;
}): CodexProviderInjection | null {
  const model = String(args.model ?? "").trim();
  if (!model) return null;
  const modelStore = createGlobalModelConfigStore(args.db);
  const config = modelStore.getModelConfigByAgentModelId(model) ?? modelStore.getModelConfig(model);
  const providerId = String(config?.providerId ?? "").trim();
  if (!providerId) return null;

  const provider = createModelProviderStore(args.db).getProvider(providerId);
  if (!provider) {
    throw new Error(`Model "${model}" references an unknown provider; re-select the model's provider.`);
  }
  if (!provider.isEnabled) {
    throw new Error(`Provider "${provider.name}" is disabled.`);
  }
  const profile = String(provider.credentialProfile ?? "").trim() || provider.id;
  const credentialStore = createUpstreamCredentialStore(args.db);
  const credentials = credentialStore.getCredentials(args.owner, profile);
  if (!credentials) {
    throw new Error(`Provider "${provider.name}" has no API key configured for this account.`);
  }
  return buildCodexProviderInjection({ provider, apiKey: credentials.apiKey });
}

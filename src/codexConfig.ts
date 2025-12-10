import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "toml";

export interface CodexOverrides {
  baseUrl?: string;
  apiKey?: string;
}

export type CodexAuthMode = "apiKey" | "deviceAuth";

export interface CodexResolvedConfig {
  baseUrl?: string;
  apiKey?: string;
  authMode: CodexAuthMode;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function resolveCodexConfig(
  overrides: CodexOverrides = {}
): CodexResolvedConfig {
  const envBaseUrl =
    process.env.CODEX_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE;
  const envApiKey =
    process.env.CODEX_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.CCHAT_OPENAI_API_KEY;

  const { baseUrl: configBaseUrl, apiKey: configApiKey, hasDeviceAuthTokens } = loadCodexFiles();

  const baseUrl =
    overrides.baseUrl ||
    envBaseUrl ||
    configBaseUrl ||
    (envApiKey || configApiKey || overrides.apiKey ? DEFAULT_BASE_URL : undefined);
  const apiKey = overrides.apiKey || envApiKey || configApiKey;

  const authMode: CodexAuthMode | undefined = apiKey
    ? "apiKey"
    : hasDeviceAuthTokens
      ? "deviceAuth"
      : undefined;

  if (!authMode) {
    throw new Error(
      "Codex credentials not found. Provide --api-key (or CODEX_API_KEY), or sign in with `codex login` to use saved access/refresh tokens in ~/.codex/auth.json."
    );
  }

  return { baseUrl, apiKey, authMode };
}

export function maskKey(key?: string): string {
  if (!key) {
    return "(none)";
  }
  if (key.length <= 8) {
    return key;
  }
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function parseSlashCommand(
  message: string
): { command: string; body: string } | null {
  if (!message.startsWith("/")) {
    return null;
  }
  const withoutSlash = message.slice(1).trim();
  if (!withoutSlash) {
    return null;
  }

  const spaceIndex = withoutSlash.indexOf(" ");
  if (spaceIndex === -1) {
    return { command: withoutSlash, body: "" };
  }

  return {
    command: withoutSlash.slice(0, spaceIndex),
    body: withoutSlash.slice(spaceIndex + 1).trim(),
  };
}

function loadCodexFiles(): Partial<CodexResolvedConfig> & { hasDeviceAuthTokens: boolean } {
  const home = homedir();
  const codexDir = join(home, ".codex");
  const configPath = join(codexDir, "config.toml");
  const authPath = join(codexDir, "auth.json");

  const result: Partial<CodexResolvedConfig> & { hasDeviceAuthTokens: boolean } = {
    hasDeviceAuthTokens: false,
  };

  if (existsSync(configPath)) {
    try {
      const rawToml = readFileSync(configPath, "utf-8");
      const parsed = parseToml(rawToml) as Record<string, unknown>;
      const providers = parsed["model_providers"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      const providerKey = String(parsed["model_provider"] || "").trim();

      if (providerKey && providers) {
        const section = providers[providerKey];
        if (section) {
          const baseUrl = section["base_url"];
          if (typeof baseUrl === "string") {
            result.baseUrl = baseUrl;
          }
          const apiKey = section["api_key"];
          if (typeof apiKey === "string") {
            result.apiKey = apiKey;
          }
        }
      }

      if (!result.baseUrl && providers) {
        for (const value of Object.values(providers)) {
          if (value && typeof value === "object") {
            const baseUrl = (value as Record<string, unknown>)["base_url"];
            if (typeof baseUrl === "string") {
              result.baseUrl = baseUrl;
              break;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to parse ${configPath}:`, err);
    }
  }

  if (existsSync(authPath)) {
    try {
      const rawAuth = readFileSync(authPath, "utf-8");
      const parsedAuth = JSON.parse(rawAuth) as Record<string, unknown>;
      const keyFromAuth = parsedAuth["OPENAI_API_KEY"];
      if (typeof keyFromAuth === "string") {
        result.apiKey = result.apiKey || keyFromAuth;
      }

      const tokens = parsedAuth["tokens"];
      if (tokens && typeof tokens === "object") {
        const tokenRecord = tokens as Record<string, unknown>;
        const hasAccessToken = typeof tokenRecord["access_token"] === "string";
        const hasRefreshToken = typeof tokenRecord["refresh_token"] === "string";
        if (hasAccessToken && hasRefreshToken) {
          result.hasDeviceAuthTokens = true;
        }
      }
    } catch (err) {
      console.warn(`Failed to parse ${authPath}:`, err);
    }
  }

  return result;
}

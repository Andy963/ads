import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "toml";

export interface CodexOverrides {
  baseUrl?: string;
  apiKey?: string;
}

export interface CodexResolvedConfig {
  baseUrl: string;
  apiKey: string;
}

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

  const { baseUrl: configBaseUrl, apiKey: configApiKey } = loadCodexFiles();

  const baseUrl = overrides.baseUrl || envBaseUrl || configBaseUrl;
  const apiKey = overrides.apiKey || envApiKey || configApiKey;

  if (!baseUrl) {
    throw new Error(
      "Codex base URL not found. Provide --base-url, set CODEX_BASE_URL, or configure ~/.codex/config.toml."
    );
  }

  if (!apiKey) {
    throw new Error(
      "Codex API key not found. Provide --api-key, set CODEX_API_KEY, or configure ~/.codex/auth.json."
    );
  }

  return { baseUrl, apiKey };
}

export function maskKey(key: string): string {
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

function loadCodexFiles(): Partial<CodexResolvedConfig> {
  const home = homedir();
  const codexDir = join(home, ".codex");
  const configPath = join(codexDir, "config.toml");
  const authPath = join(codexDir, "auth.json");

  const result: Partial<CodexResolvedConfig> = {};

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
      const parsedAuth = JSON.parse(rawAuth) as Record<string, string>;
      const keyFromAuth = parsedAuth["OPENAI_API_KEY"];
      if (typeof keyFromAuth === "string") {
        result.apiKey = result.apiKey || keyFromAuth;
      }
    } catch (err) {
      console.warn(`Failed to parse ${authPath}:`, err);
    }
  }

  return result;
}

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createLogger } from "../utils/logger.js";

export interface AgentFeatureFlags {
  claudeEnabled: boolean;
  geminiEnabled: boolean;
}

export interface ClaudeAgentConfig {
  enabled: boolean;
  apiKey?: string;
  model: string;
  workdir: string;
  toolAllowlist: string[];
  baseUrl?: string;
}

export interface GeminiAgentConfig {
  enabled: boolean;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  accessToken?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  googleAuthKeyFile?: string;
}

interface ClaudeFileConfig {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  workdir?: string;
  toolAllowlist?: string[];
  baseUrl?: string;
}

interface GeminiFileConfig {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  apiVersion?: string;
  accessToken?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  googleAuthKeyFile?: string;
}

const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4.5";
const GEMINI_DEFAULT_MODEL = "gemini-2.0-flash";
const logger = createLogger("AgentConfig");

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeToolAllowlist(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const parsed = parseList(value);
    return parsed.length > 0 ? parsed : [];
  }
  return undefined;
}

function resolveEnabledFlag(envValue: string | undefined, fileValue: boolean | undefined, hasApiKey: boolean): boolean {
  if (envValue !== undefined) {
    return parseBoolean(envValue, false);
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return hasApiKey;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    let value = normalized.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const commentIndex = value.indexOf(" #");
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trimEnd();
    }
    result[key] = value;
  }
  return result;
}

function readEnvFileIfExists(filePath: string): Record<string, string> | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return parseEnvFile(readFileSync(filePath, "utf-8"));
  } catch (error) {
    logger.warn(`[GeminiConfig] Failed to parse ${filePath}`, error);
    return null;
  }
}

function looksLikeAuthorizedUserCredentials(value: unknown): value is { client_id: string; client_secret: string; refresh_token: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.client_id === "string" &&
    typeof record.client_secret === "string" &&
    typeof record.refresh_token === "string"
  );
}

function loadClaudeConfigFiles(): ClaudeFileConfig {
  const home = homedir();
  const configDir = join(home, ".claude");
  const configPath = join(configDir, "config.json");
  const authPath = join(configDir, "auth.json");
  const settingsPath = join(configDir, "settings.json");
  const result: ClaudeFileConfig = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.enabled === "boolean") {
        result.enabled = parsed.enabled;
      }
      const apiKey = parsed.apiKey ?? parsed.api_key ?? parsed.ANTHROPIC_API_KEY;
      if (typeof apiKey === "string") {
        result.apiKey = apiKey;
      }
      const model = parsed.model ?? parsed.default_model;
      if (typeof model === "string") {
        result.model = model;
      }
      if (typeof parsed.workdir === "string") {
        result.workdir = parsed.workdir;
      } else if (typeof parsed.work_dir === "string") {
        result.workdir = parsed.work_dir;
      }
      const allowlist =
        normalizeToolAllowlist(parsed.toolAllowlist) ??
        normalizeToolAllowlist(parsed.tool_allowlist);
      if (allowlist) {
        result.toolAllowlist = allowlist;
      }
      const baseUrl = parsed.baseUrl ?? parsed.base_url;
      if (typeof baseUrl === "string") {
        result.baseUrl = baseUrl;
      }
    } catch (error) {
      logger.warn(`[ClaudeConfig] Failed to parse ${configPath}`, error);
    }
  }

  if (existsSync(authPath)) {
    try {
      const authRaw = readFileSync(authPath, "utf-8");
      const parsedAuth = JSON.parse(authRaw) as Record<string, unknown>;
      const authKey =
        parsedAuth.ANTHROPIC_API_KEY ??
        parsedAuth.CLAUDE_API_KEY ??
        parsedAuth.api_key;
      if (typeof authKey === "string" && !result.apiKey) {
        result.apiKey = authKey;
      }
    } catch (error) {
      logger.warn(`[ClaudeConfig] Failed to parse ${authPath}`, error);
    }
  }

  if (existsSync(settingsPath)) {
    try {
      const rawSettings = readFileSync(settingsPath, "utf-8");
      const parsedSettings = JSON.parse(rawSettings) as Record<string, unknown>;
      if (typeof parsedSettings.enabled === "boolean" && result.enabled === undefined) {
        result.enabled = parsedSettings.enabled;
      }
      const envSection = parsedSettings.env;
      if (envSection && typeof envSection === "object") {
        const envRecord = envSection as Record<string, unknown>;
        const envKey =
          envRecord.ANTHROPIC_AUTH_TOKEN ??
          envRecord.ANTHROPIC_API_KEY ??
          envRecord.CLAUDE_API_KEY;
        if (typeof envKey === "string" && !result.apiKey) {
          result.apiKey = envKey;
        }
        const envBase =
          envRecord.ANTHROPIC_BASE_URL ??
          envRecord.CLAUDE_BASE_URL;
        if (typeof envBase === "string" && !result.baseUrl) {
          result.baseUrl = envBase;
        }
      }
    } catch (error) {
      logger.warn(`[ClaudeConfig] Failed to parse ${settingsPath}`, error);
    }
  }

  return result;
}

function loadGeminiConfigFiles(): GeminiFileConfig {
  const home = homedir();
  const configDir = process.env.GEMINI_CONFIG_DIR
    ? resolve(process.env.GEMINI_CONFIG_DIR)
    : join(home, ".gemini");

  const result: GeminiFileConfig = {};

  const configPath = join(configDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.enabled === "boolean") {
        result.enabled = parsed.enabled;
      }
      const apiKey = parsed.apiKey ?? parsed.api_key ?? parsed.GEMINI_API_KEY ?? parsed.GOOGLE_API_KEY;
      if (typeof apiKey === "string") {
        result.apiKey = apiKey;
      }
      const model = parsed.model ?? parsed.default_model;
      if (typeof model === "string") {
        result.model = model;
      }
      const apiVersion = parsed.apiVersion ?? parsed.api_version;
      if (typeof apiVersion === "string") {
        result.apiVersion = apiVersion;
      }
      const accessToken = parsed.accessToken ?? parsed.access_token;
      if (typeof accessToken === "string") {
        result.accessToken = accessToken;
      }
      if (typeof parsed.vertexai === "boolean") {
        result.vertexai = parsed.vertexai;
      }
      if (typeof parsed.project === "string") {
        result.project = parsed.project;
      }
      if (typeof parsed.location === "string") {
        result.location = parsed.location;
      }
      const baseUrl =
        parsed.baseUrl ??
        parsed.base_url ??
        parsed.GEMINI_BASE_URL ??
        parsed.GOOGLE_GEMINI_BASE_URL ??
        parsed.GOOGLE_VERTEX_BASE_URL;
      if (typeof baseUrl === "string") {
        result.baseUrl = baseUrl;
      }
      const googleAuthKeyFile =
        parsed.googleAuthKeyFile ??
        parsed.google_auth_key_file ??
        parsed.google_application_credentials ??
        parsed.GOOGLE_APPLICATION_CREDENTIALS;
      if (typeof googleAuthKeyFile === "string") {
        result.googleAuthKeyFile = googleAuthKeyFile;
      }
    } catch (error) {
      logger.warn(`[GeminiConfig] Failed to parse ${configPath}`, error);
    }
  }

  const envPath = join(configDir, ".env");
  const envLocalPath = join(configDir, ".env.local");
  const legacyEnvPath = join(configDir, ".ven");
  const legacyEnvLocalPath = join(configDir, ".ven.local");

  const envFromFile = readEnvFileIfExists(envPath) ?? readEnvFileIfExists(legacyEnvPath);
  const envFromLocal = readEnvFileIfExists(envLocalPath) ?? readEnvFileIfExists(legacyEnvLocalPath);

  const mergedEnv: Record<string, string> = {
    ...(envFromFile ?? {}),
    ...(envFromLocal ?? {}),
  };

  if (mergedEnv.ENABLE_GEMINI_AGENT !== undefined) {
    result.enabled = parseBoolean(mergedEnv.ENABLE_GEMINI_AGENT, false);
  }

  const key = mergedEnv.GEMINI_API_KEY || mergedEnv.GOOGLE_API_KEY;
  if (key) {
    result.apiKey = key;
  }
  if (mergedEnv.GEMINI_MODEL) {
    result.model = mergedEnv.GEMINI_MODEL;
  }
  if (mergedEnv.GEMINI_API_VERSION) {
    result.apiVersion = mergedEnv.GEMINI_API_VERSION;
  }
  if (mergedEnv.GEMINI_ACCESS_TOKEN) {
    result.accessToken = mergedEnv.GEMINI_ACCESS_TOKEN;
  }

  if (mergedEnv.GOOGLE_GENAI_USE_VERTEXAI !== undefined) {
    result.vertexai = parseBoolean(mergedEnv.GOOGLE_GENAI_USE_VERTEXAI, false);
  }

  const explicitBaseUrl = mergedEnv.GEMINI_BASE_URL;
  const geminiBaseUrl = mergedEnv.GOOGLE_GEMINI_BASE_URL;
  const vertexBaseUrl = mergedEnv.GOOGLE_VERTEX_BASE_URL;
  if (explicitBaseUrl) {
    result.baseUrl = explicitBaseUrl;
  } else if (result.vertexai) {
    if (vertexBaseUrl || geminiBaseUrl) {
      result.baseUrl = vertexBaseUrl || geminiBaseUrl;
    }
  } else if (geminiBaseUrl || vertexBaseUrl) {
    result.baseUrl = geminiBaseUrl || vertexBaseUrl;
  }

  if (mergedEnv.GOOGLE_CLOUD_PROJECT) {
    result.project = mergedEnv.GOOGLE_CLOUD_PROJECT;
  }
  if (mergedEnv.GOOGLE_CLOUD_LOCATION) {
    result.location = mergedEnv.GOOGLE_CLOUD_LOCATION;
  }
  if (mergedEnv.GOOGLE_APPLICATION_CREDENTIALS) {
    result.googleAuthKeyFile = mergedEnv.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (mergedEnv.GEMINI_GOOGLE_APPLICATION_CREDENTIALS) {
    result.googleAuthKeyFile = mergedEnv.GEMINI_GOOGLE_APPLICATION_CREDENTIALS;
  }

  const authPath = join(configDir, "auth.json");
  if (existsSync(authPath)) {
    try {
      const raw = readFileSync(authPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      const apiKey = parsed.GEMINI_API_KEY ?? parsed.GOOGLE_API_KEY ?? parsed.apiKey ?? parsed.api_key;
      if (typeof apiKey === "string" && !result.apiKey) {
        result.apiKey = apiKey;
      }

      const accessToken = parsed.access_token ?? parsed.accessToken;
      if (typeof accessToken === "string" && !result.accessToken) {
        result.accessToken = accessToken;
      }

      if (!result.googleAuthKeyFile && looksLikeAuthorizedUserCredentials(parsed)) {
        result.googleAuthKeyFile = authPath;
      }
    } catch (error) {
      logger.warn(`[GeminiConfig] Failed to parse ${authPath}`, error);
    }
  }

  return result;
}

export function getAgentFeatureFlags(): AgentFeatureFlags {
  const fileConfig = loadClaudeConfigFiles();
  const envApiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  const effectiveKey = envApiKey || fileConfig.apiKey;
  const geminiFileConfig = loadGeminiConfigFiles();
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || geminiFileConfig.apiKey;
  const vertexaiEnv = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const vertexaiEnabled = vertexaiEnv !== undefined ? parseBoolean(vertexaiEnv, false) : Boolean(geminiFileConfig.vertexai);
  const geminiHasAuth =
    Boolean(geminiApiKey) ||
    Boolean(process.env.GEMINI_ACCESS_TOKEN || geminiFileConfig.accessToken) ||
    vertexaiEnabled;
  return {
    claudeEnabled: resolveEnabledFlag(process.env.ENABLE_CLAUDE_AGENT, fileConfig.enabled, Boolean(effectiveKey)),
    geminiEnabled: resolveEnabledFlag(process.env.ENABLE_GEMINI_AGENT, geminiFileConfig.enabled, geminiHasAuth),
  };
}

export function resolveClaudeAgentConfig(): ClaudeAgentConfig {
  const fileConfig = loadClaudeConfigFiles();
  const envApiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  const apiKey = envApiKey || fileConfig.apiKey;
  const envBase =
    process.env.CLAUDE_BASE_URL ||
    process.env.CLAUDE_API_BASE ||
    process.env.ANTHROPIC_BASE_URL;
  const baseUrl = envBase || fileConfig.baseUrl;
  const defaultWorkdir =
    process.env.CLAUDE_WORKDIR || fileConfig.workdir || join(tmpdir(), "ads-claude-agent");
  const envToolList = process.env.CLAUDE_TOOL_ALLOWLIST;
  const toolAllowlist =
    envToolList !== undefined
      ? parseList(envToolList)
      : fileConfig.toolAllowlist ?? [];
  return {
    enabled: resolveEnabledFlag(process.env.ENABLE_CLAUDE_AGENT, fileConfig.enabled, Boolean(apiKey)),
    apiKey,
    model: process.env.CLAUDE_MODEL || fileConfig.model || CLAUDE_DEFAULT_MODEL,
    workdir: defaultWorkdir,
    toolAllowlist,
    baseUrl,
  };
}

export function resolveGeminiAgentConfig(): GeminiAgentConfig {
  const fileConfig = loadGeminiConfigFiles();
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || fileConfig.apiKey;
  const accessToken = process.env.GEMINI_ACCESS_TOKEN || fileConfig.accessToken;
  const vertexaiEnv = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const vertexai = vertexaiEnv !== undefined ? parseBoolean(vertexaiEnv, false) : fileConfig.vertexai;
  const baseUrl = process.env.GEMINI_BASE_URL || fileConfig.baseUrl;
  const apiVersion = process.env.GEMINI_API_VERSION || fileConfig.apiVersion;
  const project = process.env.GOOGLE_CLOUD_PROJECT || fileConfig.project;
  const location = process.env.GOOGLE_CLOUD_LOCATION || fileConfig.location;
  const googleAuthKeyFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GEMINI_GOOGLE_APPLICATION_CREDENTIALS ||
    fileConfig.googleAuthKeyFile;

  const hasAuth = Boolean(apiKey) || Boolean(accessToken) || Boolean(vertexai);
  return {
    enabled: resolveEnabledFlag(process.env.ENABLE_GEMINI_AGENT, fileConfig.enabled, hasAuth),
    apiKey,
    model: process.env.GEMINI_MODEL || fileConfig.model || GEMINI_DEFAULT_MODEL,
    baseUrl,
    apiVersion,
    accessToken,
    vertexai,
    project,
    location,
    googleAuthKeyFile,
  };
}

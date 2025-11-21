import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

interface ClaudeFileConfig {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  workdir?: string;
  toolAllowlist?: string[];
  baseUrl?: string;
}

const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4.5";

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
      console.warn(`[ClaudeConfig] Failed to parse ${configPath}:`, error);
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
      console.warn(`[ClaudeConfig] Failed to parse ${authPath}:`, error);
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
      console.warn(`[ClaudeConfig] Failed to parse ${settingsPath}:`, error);
    }
  }

  return result;
}

export function getAgentFeatureFlags(): AgentFeatureFlags {
  const fileConfig = loadClaudeConfigFiles();
  const envApiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  const effectiveKey = envApiKey || fileConfig.apiKey;
  return {
    claudeEnabled: resolveEnabledFlag(process.env.ENABLE_CLAUDE_AGENT, fileConfig.enabled, Boolean(effectiveKey)),
    geminiEnabled: parseBoolean(process.env.ENABLE_GEMINI_AGENT, false),
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

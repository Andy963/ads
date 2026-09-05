import path from "node:path";

import { z } from "zod";

import { parseBooleanFlag } from "./utils/flags.js";

type EnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface SharedConfig {
  allowedDirs: string[];
  sandboxMode: SandboxMode;
}

export interface WebConfig {
  port: number;
  host: string;
  maxClients: number;
  wsPingIntervalMs: number;
  wsMaxMissedPongs: number;
  wsMaxPayloadBytes: number;
  historyMaxEntriesPerSession: number;
  historyMaxTextLength: number;
  historyRetentionDays: number;
  historyMaxStoredBytes: number;
  historyMaintenanceIntervalMs: number;
  sessionTimeoutMs: number;
  sessionCleanupIntervalMs: number;
  allowedOriginsRaw?: string;
  plannerCodexModel?: string;
  traceWsDuplication: boolean;
}

export interface AgentConfig {
  skillAutoloadEnabled: boolean;
  skillAutosaveEnabled: boolean;
  preferenceDirectiveEnabled: boolean;
}

interface SharedConfigOptions {
  env?: EnvSource;
  fallbackAllowedDir?: string;
  resolveAllowedDirPaths?: boolean;
  fallbackWhenAllowedDirsEmpty?: boolean;
}

interface DomainConfigOptions {
  env?: EnvSource;
}

const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

const sharedConfigSchema = z.object({
  allowedDirs: z.array(z.string()),
  sandboxMode: sandboxModeSchema,
});

const webConfigSchema = z.object({
  port: z.number().finite(),
  host: z.string(),
  maxClients: z.number().int().min(1),
  wsPingIntervalMs: z.number().min(0),
  wsMaxMissedPongs: z.number().int().min(0),
  wsMaxPayloadBytes: z.number().int().min(1024),
  historyMaxEntriesPerSession: z.number().int().min(1),
  historyMaxTextLength: z.number().int().min(1),
  historyRetentionDays: z.number().int().min(0),
  historyMaxStoredBytes: z.number().int().min(0),
  historyMaintenanceIntervalMs: z.number().int().min(0),
  sessionTimeoutMs: z.number().int().min(0),
  sessionCleanupIntervalMs: z.number().int().min(0),
  allowedOriginsRaw: z.string().optional(),
  plannerCodexModel: z.string().optional(),
  traceWsDuplication: z.boolean(),
});

const agentConfigSchema = z.object({
  skillAutoloadEnabled: z.boolean(),
  skillAutosaveEnabled: z.boolean(),
  preferenceDirectiveEnabled: z.boolean(),
});

function getEnv(options?: DomainConfigOptions): EnvSource {
  return options?.env ?? process.env;
}

function normalizeOptionalString(raw: string | undefined): string | undefined {
  const trimmed = String(raw ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSandboxMode(raw: string | undefined): SandboxMode {
  const value = raw ?? "workspace-write";
  const parsed = sandboxModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid SANDBOX_MODE: ${value}. Must be one of: ${sandboxModeSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

function normalizeAllowedDirs(
  raw: string | undefined,
  fallbackAllowedDir: string,
  options: { resolvePaths: boolean; fallbackWhenEmpty: boolean },
): string[] {
  const source = raw || fallbackAllowedDir;
  const list = source.split(",").map((dir) => dir.trim()).filter(Boolean);
  if (list.length === 0 && options.fallbackWhenEmpty) {
    const fallback = options.resolvePaths ? path.resolve(fallbackAllowedDir) : fallbackAllowedDir;
    return [fallback];
  }
  return options.resolvePaths ? list.map((dir) => path.resolve(dir)) : list;
}

function normalizeWebNumber(raw: string | undefined, defaultValue: number, minimum: number): number {
  const parsed = Number(raw ?? defaultValue);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(minimum, parsed);
}

function normalizeWebInteger(raw: string | undefined, defaultValue: number, minimum: number): number {
  const parsed = Number(raw ?? defaultValue);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(minimum, Math.floor(parsed));
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_WEB_SESSION_TIMEOUT_HOURS = 24;

function resolveWebSessionTimeoutMs(env: EnvSource): number {
  const rawMs = normalizeOptionalString(env.ADS_WEB_SESSION_TIMEOUT_MS);
  if (rawMs !== undefined) {
    return normalizeWebInteger(rawMs, DEFAULT_WEB_SESSION_TIMEOUT_HOURS * HOUR_MS, 0);
  }
  const hours = normalizeWebInteger(env.ADS_WEB_SESSION_TIMEOUT_HOURS, DEFAULT_WEB_SESSION_TIMEOUT_HOURS, 0);
  return hours * HOUR_MS;
}

function resolveWebSessionCleanupIntervalMs(env: EnvSource): number {
  const rawMs = normalizeOptionalString(env.ADS_WEB_SESSION_CLEANUP_INTERVAL_MS);
  if (rawMs !== undefined) {
    return normalizeWebInteger(rawMs, 5 * MINUTE_MS, 0);
  }
  const minutes = normalizeWebInteger(env.ADS_WEB_SESSION_CLEANUP_INTERVAL_MINUTES, 5, 0);
  return minutes * MINUTE_MS;
}

export function resolveSharedConfig(options: SharedConfigOptions = {}): SharedConfig {
  const env = getEnv(options);
  return sharedConfigSchema.parse({
    allowedDirs: normalizeAllowedDirs(env.ALLOWED_DIRS, options.fallbackAllowedDir ?? process.cwd(), {
      resolvePaths: options.resolveAllowedDirPaths ?? false,
      fallbackWhenEmpty: options.fallbackWhenAllowedDirsEmpty ?? true,
    }),
    sandboxMode: normalizeSandboxMode(env.SANDBOX_MODE),
  });
}

export function resolveWebConfig(options: DomainConfigOptions = {}): WebConfig {
  const env = getEnv(options);
  return webConfigSchema.parse({
    port: Number(env.ADS_WEB_PORT) || 8787,
    host: env.ADS_WEB_HOST || "127.0.0.1",
    maxClients: normalizeWebInteger(env.ADS_WEB_MAX_CLIENTS, 32, 1),
    wsPingIntervalMs: normalizeWebNumber(env.ADS_WEB_WS_PING_INTERVAL_MS, 15_000, 0),
    wsMaxMissedPongs: normalizeWebInteger(env.ADS_WEB_WS_MAX_MISSED_PONGS, 3, 0),
    // 单帧上限：默认 16MB，足以容纳带 base64 图片的 prompt，又能挡住内存型 DoS。
    wsMaxPayloadBytes: normalizeWebInteger(env.ADS_WEB_WS_MAX_PAYLOAD_BYTES, 16 * 1024 * 1024, 1024),
    historyMaxEntriesPerSession: normalizeWebInteger(env.ADS_HISTORY_MAX_ENTRIES_PER_SESSION, 200, 1),
    historyMaxTextLength: normalizeWebInteger(env.ADS_HISTORY_MAX_TEXT_LENGTH, 64 * 1024, 1),
    historyRetentionDays: normalizeWebInteger(env.ADS_HISTORY_RETENTION_DAYS, 90, 0),
    historyMaxStoredBytes: normalizeWebInteger(env.ADS_HISTORY_MAX_STORED_BYTES, 256 * 1024 * 1024, 0),
    historyMaintenanceIntervalMs:
      normalizeWebInteger(env.ADS_HISTORY_MAINTENANCE_INTERVAL_MINUTES, 60, 0) * MINUTE_MS,
    sessionTimeoutMs: resolveWebSessionTimeoutMs(env),
    sessionCleanupIntervalMs: resolveWebSessionCleanupIntervalMs(env),
    allowedOriginsRaw: env.ADS_WEB_ALLOWED_ORIGINS,
    plannerCodexModel: normalizeOptionalString(env.ADS_PLANNER_CODEX_MODEL),
    traceWsDuplication: parseBooleanFlag(env.ADS_TRACE_WS_DUPLICATION, false),
  });
}

export function resolveAgentConfig(options: DomainConfigOptions = {}): AgentConfig {
  const env = getEnv(options);
  return agentConfigSchema.parse({
    skillAutoloadEnabled: parseBooleanFlag(env.ADS_SKILLS_AUTOLOAD, true),
    skillAutosaveEnabled: parseBooleanFlag(env.ADS_SKILLS_AUTOSAVE, true),
    preferenceDirectiveEnabled: parseBooleanFlag(env.ADS_PREFERENCE_DIRECTIVES, true),
  });
}

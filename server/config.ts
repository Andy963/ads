import path from "node:path";

import { z } from "zod";

import { parseBooleanFlag, parsePositiveIntFlag } from "./utils/flags.js";

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
  sessionTimeoutMs: number;
  sessionCleanupIntervalMs: number;
  allowedOriginsRaw?: string;
  plannerCodexModel?: string;
  reviewerCodexModel?: string;
  taskQueueEnabled: boolean;
  taskQueueAutoStart: boolean;
  traceWsDuplication: boolean;
}

export interface AgentConfig {
  skillAutoloadEnabled: boolean;
  skillAutosaveEnabled: boolean;
  preferenceDirectiveEnabled: boolean;
  taskMaxParallel: number;
  taskTimeoutMs: number;
  taskMaxAttempts: number;
  taskRetryBackoffMs: number;
}

export interface ResolvedTelegramConfig {
  botToken: string;
  allowedUsers: number[];
  allowedDirs: string[];
  maxRequestsPerMinute: number;
  sessionTimeoutMs: number;
  streamUpdateIntervalMs: number;
  sandboxMode: SandboxMode;
  defaultModel?: string;
  proxyUrl?: string;
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

interface TelegramConfigOptions extends DomainConfigOptions {
  fallbackAllowedDir?: string;
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
  sessionTimeoutMs: z.number().int().min(0),
  sessionCleanupIntervalMs: z.number().int().min(0),
  allowedOriginsRaw: z.string().optional(),
  plannerCodexModel: z.string().optional(),
  reviewerCodexModel: z.string().optional(),
  taskQueueEnabled: z.boolean(),
  taskQueueAutoStart: z.boolean(),
  traceWsDuplication: z.boolean(),
});

const agentConfigSchema = z.object({
  skillAutoloadEnabled: z.boolean(),
  skillAutosaveEnabled: z.boolean(),
  preferenceDirectiveEnabled: z.boolean(),
  taskMaxParallel: z.number().int().positive(),
  taskTimeoutMs: z.number().int().positive(),
  taskMaxAttempts: z.number().int().positive(),
  taskRetryBackoffMs: z.number().int().positive(),
});

const telegramConfigSchema = z.object({
  botToken: z.string().min(1),
  allowedUsers: z.array(z.number().int().positive()).min(1),
  allowedDirs: z.array(z.string()),
  maxRequestsPerMinute: z.number().int().positive(),
  sessionTimeoutMs: z.number().int().min(0),
  streamUpdateIntervalMs: z.number().int().positive(),
  sandboxMode: sandboxModeSchema,
  defaultModel: z.string().optional(),
  proxyUrl: z.string().optional(),
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

function parseRequiredString(raw: string | undefined, name: string): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInt(raw: string | undefined, label: string): number {
  const trimmed = raw?.trim() ?? "";
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid value for ${label} (must be a positive integer): ${raw ?? ""}`);
  }
  return value;
}

function parseTelegramAllowedUsers(env: EnvSource): number[] {
  const singleUserRaw = String(env.TELEGRAM_ALLOWED_USER_ID ?? "").trim();
  const allowedUsersRaw = String(env.TELEGRAM_ALLOWED_USERS ?? "").trim();

  if (singleUserRaw) {
    const userId = parsePositiveInt(singleUserRaw, "TELEGRAM_ALLOWED_USER_ID");
    if (allowedUsersRaw) {
      const parts = allowedUsersRaw.split(",").map((part) => part.trim()).filter(Boolean);
      if (parts.length !== 1) {
        throw new Error("TELEGRAM_ALLOWED_USERS must contain exactly one user ID when TELEGRAM_ALLOWED_USER_ID is set");
      }
      const legacyId = parsePositiveInt(parts[0] ?? "", "TELEGRAM_ALLOWED_USERS");
      if (legacyId !== userId) {
        throw new Error("TELEGRAM_ALLOWED_USER_ID conflicts with TELEGRAM_ALLOWED_USERS (values differ)");
      }
    }
    return [userId];
  }

  if (!allowedUsersRaw) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID is required (single user ID)");
  }

  const parts = allowedUsersRaw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 1) {
    throw new Error("TELEGRAM_ALLOWED_USERS must contain exactly one user ID for this bot");
  }
  return [parsePositiveInt(parts[0] ?? "", "TELEGRAM_ALLOWED_USERS")];
}

function parsePositiveNumberWithDefault(raw: string | undefined, defaultValue: number, label: string): number {
  const value = Number.parseInt(raw ?? String(defaultValue), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function parseNonNegativeNumberWithDefault(raw: string | undefined, defaultValue: number, label: string): number {
  const value = Number.parseInt(raw ?? String(defaultValue), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number (0 disables timeout)`);
  }
  return value;
}

function normalizeProxyUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
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

function resolveWebSessionTimeoutMs(env: EnvSource): number {
  const rawMs = normalizeOptionalString(env.ADS_WEB_SESSION_TIMEOUT_MS);
  if (rawMs !== undefined) {
    return normalizeWebInteger(rawMs, 24 * HOUR_MS, 0);
  }
  const hours = normalizeWebInteger(env.ADS_WEB_SESSION_TIMEOUT_HOURS, 24, 0);
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
    sessionTimeoutMs: resolveWebSessionTimeoutMs(env),
    sessionCleanupIntervalMs: resolveWebSessionCleanupIntervalMs(env),
    allowedOriginsRaw: env.ADS_WEB_ALLOWED_ORIGINS,
    plannerCodexModel: normalizeOptionalString(env.ADS_PLANNER_CODEX_MODEL),
    reviewerCodexModel: normalizeOptionalString(env.ADS_REVIEWER_CODEX_MODEL),
    taskQueueEnabled: parseBooleanFlag(env.TASK_QUEUE_ENABLED, true),
    taskQueueAutoStart: parseBooleanFlag(env.TASK_QUEUE_AUTO_START, false),
    traceWsDuplication: parseBooleanFlag(env.ADS_TRACE_WS_DUPLICATION, false),
  });
}

export function resolveAgentConfig(options: DomainConfigOptions = {}): AgentConfig {
  const env = getEnv(options);
  return agentConfigSchema.parse({
    skillAutoloadEnabled: parseBooleanFlag(env.ADS_SKILLS_AUTOLOAD, true),
    skillAutosaveEnabled: parseBooleanFlag(env.ADS_SKILLS_AUTOSAVE, true),
    preferenceDirectiveEnabled: parseBooleanFlag(env.ADS_PREFERENCE_DIRECTIVES, true),
    taskMaxParallel: parsePositiveIntFlag(env.ADS_TASK_MAX_PARALLEL, 3),
    taskTimeoutMs: parsePositiveIntFlag(env.ADS_TASK_TIMEOUT_MS, 2 * 60 * 1000),
    taskMaxAttempts: parsePositiveIntFlag(env.ADS_TASK_MAX_ATTEMPTS, 2),
    taskRetryBackoffMs: parsePositiveIntFlag(env.ADS_TASK_RETRY_BACKOFF_MS, 1200),
  });
}

export function resolveTelegramConfig(options: TelegramConfigOptions = {}): ResolvedTelegramConfig {
  const env = getEnv(options);
  const shared = resolveSharedConfig({
    env,
    fallbackAllowedDir: options.fallbackAllowedDir ?? process.cwd(),
    resolveAllowedDirPaths: false,
    fallbackWhenAllowedDirsEmpty: false,
  });
  return telegramConfigSchema.parse({
    botToken: parseRequiredString(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
    allowedUsers: parseTelegramAllowedUsers(env),
    allowedDirs: shared.allowedDirs,
    maxRequestsPerMinute: parsePositiveNumberWithDefault(env.TELEGRAM_MAX_RPM, 10, "TELEGRAM_MAX_RPM"),
    sessionTimeoutMs: parseNonNegativeNumberWithDefault(
      env.TELEGRAM_SESSION_TIMEOUT,
      0,
      "TELEGRAM_SESSION_TIMEOUT",
    ),
    streamUpdateIntervalMs: parsePositiveNumberWithDefault(
      env.TELEGRAM_STREAM_UPDATE_INTERVAL,
      1500,
      "TELEGRAM_STREAM_UPDATE_INTERVAL",
    ),
    sandboxMode: shared.sandboxMode,
    defaultModel: normalizeOptionalString(env.TELEGRAM_MODEL),
    proxyUrl: normalizeProxyUrl(env.TELEGRAM_PROXY_URL),
  });
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface TelegramConfig {
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

import { createLogger } from "../utils/logger.js";

const logger = createLogger("TelegramConfig");

function parsePositiveInt(raw: string, label: string): number {
  const trimmed = raw.trim();
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new Error(`Invalid value for ${label} (must be a positive integer): ${raw}`);
  }
  return num;
}

function normalizeModel(raw?: string): string | undefined {
  const trimmed = String(raw ?? "").trim();
  return trimmed ? trimmed : undefined;
}

export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const singleUserRaw = String(process.env.TELEGRAM_ALLOWED_USER_ID ?? "").trim();
  const allowedUsersRaw = String(process.env.TELEGRAM_ALLOWED_USERS ?? "").trim();

  const allowedUsers = (() => {
    if (singleUserRaw) {
      const userId = parsePositiveInt(singleUserRaw, "TELEGRAM_ALLOWED_USER_ID");
      if (allowedUsersRaw) {
        const parts = allowedUsersRaw.split(",").map((s) => s.trim()).filter(Boolean);
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
    const parts = allowedUsersRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length !== 1) {
      throw new Error("TELEGRAM_ALLOWED_USERS must contain exactly one user ID for this bot");
    }
    return [parsePositiveInt(parts[0] ?? "", "TELEGRAM_ALLOWED_USERS")];
  })();

  const allowedDirsStr = process.env.ALLOWED_DIRS || process.cwd();
  const allowedDirs = allowedDirsStr.split(',').map(dir => dir.trim()).filter(Boolean);

  const maxRequestsPerMinute = parseInt(process.env.TELEGRAM_MAX_RPM || '10', 10);
  if (!Number.isFinite(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) {
    throw new Error('TELEGRAM_MAX_RPM must be a positive number');
  }

  const sessionTimeoutMs = parseInt(process.env.TELEGRAM_SESSION_TIMEOUT || '0', 10);
  if (!Number.isFinite(sessionTimeoutMs) || sessionTimeoutMs < 0) {
    throw new Error('TELEGRAM_SESSION_TIMEOUT must be a non-negative number (0 disables timeout)');
  }

  const streamUpdateIntervalMs = parseInt(process.env.TELEGRAM_STREAM_UPDATE_INTERVAL || '1500', 10);
  if (!Number.isFinite(streamUpdateIntervalMs) || streamUpdateIntervalMs <= 0) {
    throw new Error('TELEGRAM_STREAM_UPDATE_INTERVAL must be a positive number');
  }

  const sandboxMode = (process.env.SANDBOX_MODE || 'workspace-write') as SandboxMode;
  const validModes: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
  if (!validModes.includes(sandboxMode)) {
    throw new Error(`Invalid SANDBOX_MODE: ${sandboxMode}. Must be one of: ${validModes.join(', ')}`);
  }

  const defaultModel = normalizeModel(process.env.TELEGRAM_MODEL);
  const proxyUrl = normalizeProxyUrl(process.env.TELEGRAM_PROXY_URL);
  return {
    botToken,
    allowedUsers,
    allowedDirs,
    maxRequestsPerMinute,
    sessionTimeoutMs,
    streamUpdateIntervalMs,
    sandboxMode,
    defaultModel,
    proxyUrl,
  };
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

export function validateConfig(config: TelegramConfig): void {
  if (!config.botToken) {
    throw new Error('Bot token is empty');
  }

  if (config.allowedUsers.length === 0) {
    throw new Error('Allowed users list is empty');
  }

  if (config.allowedUsers.length !== 1) {
    throw new Error('Telegram bot supports exactly one allowed user (set TELEGRAM_ALLOWED_USER_ID)');
  }

  if (config.allowedDirs.length === 0) {
    throw new Error('Allowed directories list is empty');
  }

  for (const dir of config.allowedDirs) {
    if (!dir.startsWith('/')) {
      logger.warn(`Directory "${dir}" is not an absolute path`);
    }
  }
}

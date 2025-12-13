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

export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const allowedUsersStr = process.env.TELEGRAM_ALLOWED_USERS;
  if (!allowedUsersStr) {
    throw new Error('TELEGRAM_ALLOWED_USERS is required (comma-separated user IDs)');
  }

  const allowedUsers = allowedUsersStr
    .split(',')
    .map(id => {
      const num = parseInt(id.trim(), 10);
      if (!Number.isSafeInteger(num) || num <= 0) {
        throw new Error(`Invalid user ID in TELEGRAM_ALLOWED_USERS (must be a positive integer): ${id}`);
      }
      return num;
    });

  if (allowedUsers.length === 0) {
    throw new Error('TELEGRAM_ALLOWED_USERS must contain at least one user ID');
  }

  const allowedDirsStr = process.env.ALLOWED_DIRS || process.cwd();
  const allowedDirs = allowedDirsStr.split(',').map(dir => dir.trim()).filter(Boolean);

  const maxRequestsPerMinute = parseInt(process.env.TELEGRAM_MAX_RPM || '10', 10);
  if (!Number.isFinite(maxRequestsPerMinute) || maxRequestsPerMinute <= 0) {
    throw new Error('TELEGRAM_MAX_RPM must be a positive number');
  }

  const sessionTimeoutMs = parseInt(process.env.TELEGRAM_SESSION_TIMEOUT || '1800000', 10);
  if (!Number.isFinite(sessionTimeoutMs) || sessionTimeoutMs <= 0) {
    throw new Error('TELEGRAM_SESSION_TIMEOUT must be a positive number');
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

  const defaultModel = process.env.TELEGRAM_MODEL; // 可选，不设置则使用 SDK 默认
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
    throw new Error('TELEGRAM_ALLOWED_USERS must contain exactly one user ID for this bot');
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

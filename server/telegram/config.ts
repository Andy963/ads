import { createLogger } from "../utils/logger.js";
import {
  resolveTelegramConfig,
  type ResolvedTelegramConfig,
  type SandboxMode,
} from "../config.js";

export type { SandboxMode };
export type TelegramConfig = ResolvedTelegramConfig;

const logger = createLogger("TelegramConfig");

export function loadTelegramConfig(): TelegramConfig {
  return resolveTelegramConfig();
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

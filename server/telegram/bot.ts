import '../utils/logSink.js';
import '../utils/env.js';

import { Bot } from 'grammy';
import { loadTelegramConfig, validateConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { resolveCodexConfig } from '../codexConfig.js';
import { SessionManager } from './utils/sessionManager.js';
import { DirectoryManager } from './utils/directoryManager.js';
import { cleanupAllTempFiles } from './utils/fileHandler.js';
import { createLogger } from '../utils/logger.js';
import { closeSharedDatabases, createGracefulCleanup } from '../utils/shutdown.js';
import { HttpsProxyAgent } from './utils/proxyAgent.js';
import { installApiDebugLogging, installSilentReplyMiddleware, parseBooleanFlag } from './botSetup.js';
import { PendingTranscriptionStore } from './utils/pendingTranscriptions.js';
import { registerTelegramCommandMenu, registerTelegramControlCommands } from './commands/registerControlCommands.js';
import { registerTelegramMessageHandlers } from './commands/registerMessageHandlers.js';
import { AgentScheduleCompiler } from '../scheduler/compiler.js';
import { SchedulerRuntime } from '../scheduler/runtime.js';

const logger = createLogger('Bot');
const markStates = new Map<number, boolean>();
let cleanup = createGracefulCleanup({ logger });

const TELEGRAM_POLLING_CONFLICT_EXIT_CODE = 75;

type TelegramApiErrorLike = {
  error_code?: unknown;
  description?: unknown;
  method?: unknown;
};

function isTelegramPollingConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as TelegramApiErrorLike;
  const errorCode = Number(record.error_code);
  const description = String(record.description ?? '');
  const method = String(record.method ?? '');
  return errorCode === 409 && method === 'getUpdates' && /terminated by other getUpdates request/i.test(description);
}

process.once('unhandledRejection', (reason) => {
  cleanup.crash('Unhandled promise rejection', reason);
});

process.once('uncaughtException', (error) => {
  cleanup.crash('Uncaught exception', error);
});

async function main() {
  logger.info('Starting Telegram Bot...');

  // 加载配置
  let config;
  try {
    config = loadTelegramConfig();
    validateConfig(config);
    logger.info('Telegram config loaded');
    logger.info(`Single allowed user configured`);
    logger.info(`Allowed dirs: ${config.allowedDirs.join(', ')}`);
  } catch (error) {
    logger.error('Failed to load config:', (error as Error).message);
    process.exit(1);
  }

  // 验证 Codex 配置
  try {
    resolveCodexConfig();
    logger.info('Codex config validated');
  } catch (error) {
    logger.error('Failed to validate Codex config:', (error as Error).message);
    process.exit(1);
  }

  // 清理旧的临时文件
  cleanupAllTempFiles();

  const silentNotifications = parseBooleanFlag(process.env.TELEGRAM_SILENT_NOTIFICATIONS, true);
  logger.info(`[Config] TELEGRAM_SILENT_NOTIFICATIONS env=${process.env.TELEGRAM_SILENT_NOTIFICATIONS}, parsed=${silentNotifications}`);

  // 创建管理器
  const sessionManager = new SessionManager(
    config.sessionTimeoutMs,
    5 * 60 * 1000,
    config.sandboxMode,
    config.defaultModel
  );
  const directoryManager = new DirectoryManager(config.allowedDirs);
  const pendingTranscriptions = new PendingTranscriptionStore({ ttlMs: 5 * 60 * 1000 });
  const scheduleCompiler = new AgentScheduleCompiler();
  const scheduler = new SchedulerRuntime();

  // 启动时设置默认工作目录（单用户）
  const userId = config.allowedUsers[0];
  const defaultDir = config.allowedDirs[0];
  directoryManager.setUserCwd(userId, defaultDir);
  sessionManager.setUserCwd(userId, defaultDir);
  scheduler.registerWorkspace(defaultDir);
  scheduler.start();
  logger.info(`[Workspace] Using default cwd: ${defaultDir}`);

  // 创建 Bot 实例
  const clientConfig = config.proxyUrl
    ? {
      baseFetchConfig: {
        agent: new HttpsProxyAgent(config.proxyUrl),
      },
    }
    : undefined;

  const bot = new Bot(config.botToken, clientConfig ? { client: clientConfig } : undefined);

  bot.catch((error) => {
    logger.error('Unhandled bot error', (error as { error?: unknown }).error ?? error);
  });

  installApiDebugLogging(bot, logger);
  installSilentReplyMiddleware(bot, silentNotifications);

  // 注册中间件
  bot.use(createAuthMiddleware(config.allowedUsers));
  bot.use(createRateLimitMiddleware(config.maxRequestsPerMinute));

  await registerTelegramCommandMenu(bot, logger);

  const runtime = {
    logger,
    config,
    sessionManager,
    directoryManager,
    pendingTranscriptions,
    silentNotifications,
    markStates,
    scheduleCompiler,
    scheduler,
  };

  registerTelegramControlCommands(bot, runtime);
  registerTelegramMessageHandlers(bot, runtime);

  const shutdownTasks = (): void => {
    try {
      sessionManager.destroy();
    } catch (error) {
      logger.warn(`[Cleanup] destroySessionManager failed: ${(error as Error).message}`);
    }
    try {
      bot.stop();
    } catch (error) {
      logger.warn(`[Cleanup] stopBot failed: ${(error as Error).message}`);
    }
    closeSharedDatabases(logger);
    try {
      scheduler.stop();
    } catch (error) {
      logger.warn(`[Cleanup] stopScheduler failed: ${(error as Error).message}`);
    }
  };

  cleanup = createGracefulCleanup({
    logger,
    destroySessionManager: () => sessionManager.destroy(),
    stopBot: () => bot.stop(),
    tasks: [{ label: 'stopScheduler', run: () => scheduler.stop() }],
  });

  process.once('SIGINT', () => {
    cleanup.shutdown();
  });

  process.once('SIGTERM', () => {
    cleanup.shutdown();
  });

  // 启动 Bot
  logger.info('Starting long polling...');
  try {
    await bot.start({
      onStart: () => {
        logger.info('✅ Bot is running!');
      },
    });
  } catch (error) {
    if (isTelegramPollingConflict(error)) {
      logger.error(
        'Telegram polling conflict: another bot instance is already using this token. Stopping this service to avoid duplicate replies.',
        error,
      );
      shutdownTasks();
      process.exit(TELEGRAM_POLLING_CONFLICT_EXIT_CODE);
    }
    throw error;
  }
}

main().catch((error) => {
  cleanup.crash('Fatal error', error);
});

import { closeAllStateDatabases } from '../../state/database.js';
import { closeAllWorkspaceDatabases } from '../../storage/database.js';

export interface CleanupLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface CleanupResources {
  logger: CleanupLogger;
  destroySessionManager?: () => void;
  stopBot?: () => void;
  closeWorkspaceDatabases?: () => void;
  closeStateDatabases?: () => void;
  exit?: (code: number) => never | void;
  shutdownTimeoutMs?: number;
}

function cleanupResources(resources: CleanupResources): void {
  const {
    logger,
    destroySessionManager,
    stopBot,
    closeWorkspaceDatabases = closeAllWorkspaceDatabases,
    closeStateDatabases = closeAllStateDatabases,
  } = resources;

  if (destroySessionManager) {
    try {
      destroySessionManager();
    } catch (error) {
      logger.warn(`[Cleanup] destroySessionManager failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (stopBot) {
    try {
      stopBot();
    } catch (error) {
      logger.warn(`[Cleanup] stopBot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    closeWorkspaceDatabases();
  } catch (error) {
    logger.warn(`[Cleanup] closeAllWorkspaceDatabases failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    closeStateDatabases();
  } catch (error) {
    logger.warn(`[Cleanup] closeAllStateDatabases failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createGracefulCleanup(resources: CleanupResources) {
  let cleanupStarted = false;
  const exit = resources.exit ?? ((code: number) => process.exit(code));

  const runCleanup = (args: {
    level: 'info' | 'error';
    reason: string;
    error?: unknown;
    exitCode: number;
    withTimeout: boolean;
  }): void => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;

    const { level, reason, error, exitCode, withTimeout } = args;
    if (level === 'error') {
      resources.logger.error(reason, error);
    } else {
      resources.logger.info(reason);
    }

    let timer: NodeJS.Timeout | undefined;
    if (withTimeout) {
      const timeoutMsRaw = Number(resources.shutdownTimeoutMs ?? process.env.ADS_SHUTDOWN_TIMEOUT_MS ?? 1500);
      const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(100, Math.floor(timeoutMsRaw)) : 1500;
      timer = setTimeout(() => {
        exit(exitCode);
      }, timeoutMs);
      timer.unref?.();
    }

    cleanupResources(resources);

    if (timer) {
      clearTimeout(timer);
    }
    exit(exitCode);
  };

  return {
    shutdown(reason = 'Shutting down...'): void {
      runCleanup({ level: 'info', reason, exitCode: 0, withTimeout: false });
    },
    crash(reason: string, error: unknown): void {
      runCleanup({ level: 'error', reason, error, exitCode: 1, withTimeout: true });
    },
  };
}

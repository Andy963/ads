import { closeAllStateDatabases } from "../state/database.js";
import { closeAllWorkspaceDatabases } from "../storage/database.js";

export interface ShutdownLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ShutdownTask {
  label: string;
  run: () => void;
}

export interface GracefulCleanupOptions {
  logger: ShutdownLogger;
  tasks?: ShutdownTask[];
  destroySessionManager?: () => void;
  stopBot?: () => void;
  closeWorkspaceDatabases?: () => void;
  closeStateDatabases?: () => void;
  exit?: (code: number) => never | void;
  shutdownTimeoutMs?: number;
}

export function closeSharedDatabases(
  logger?: Pick<ShutdownLogger, "warn">,
  options?: Pick<GracefulCleanupOptions, "closeWorkspaceDatabases" | "closeStateDatabases">,
): void {
  try {
    (options?.closeWorkspaceDatabases ?? closeAllWorkspaceDatabases)();
  } catch (error) {
    logger?.warn(`[Cleanup] closeAllWorkspaceDatabases failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    (options?.closeStateDatabases ?? closeAllStateDatabases)();
  } catch (error) {
    logger?.warn(`[Cleanup] closeAllStateDatabases failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createGracefulCleanup(options: GracefulCleanupOptions) {
  let cleanupStarted = false;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const runTasks = (): void => {
    if (options.destroySessionManager) {
      try {
        options.destroySessionManager();
      } catch (error) {
        options.logger.warn(`[Cleanup] destroySessionManager failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.stopBot) {
      try {
        options.stopBot();
      } catch (error) {
        options.logger.warn(`[Cleanup] stopBot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    closeSharedDatabases(options.logger, options);

    for (const task of options.tasks ?? []) {
      try {
        task.run();
      } catch (error) {
        options.logger.warn(
          `[Cleanup] ${task.label} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const runCleanup = (args: {
    level: "info" | "error";
    reason: string;
    error?: unknown;
    exitCode: number;
    withTimeout: boolean;
  }): void => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;

    if (args.level === "error") {
      options.logger.error(args.reason, args.error);
    } else {
      options.logger.info(args.reason);
    }

    let timer: NodeJS.Timeout | undefined;
    if (args.withTimeout) {
      const timeoutMsRaw = Number(options.shutdownTimeoutMs ?? process.env.ADS_SHUTDOWN_TIMEOUT_MS ?? 1500);
      const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(100, Math.floor(timeoutMsRaw)) : 1500;
      timer = setTimeout(() => {
        exit(args.exitCode);
      }, timeoutMs);
      timer.unref?.();
    }

    runTasks();

    if (timer) {
      clearTimeout(timer);
    }
    exit(args.exitCode);
  };

  return {
    shutdown(reason = "Shutting down..."): void {
      runCleanup({ level: "info", reason, exitCode: 0, withTimeout: false });
    },
    crash(reason: string, error: unknown): void {
      runCleanup({ level: "error", reason, error, exitCode: 1, withTimeout: true });
    },
  };
}

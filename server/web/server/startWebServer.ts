import fs from "node:fs";
import path from "node:path";

import { parseAllowedOrigins, isOriginAllowedForRequest } from "../auth/origin.js";
import { createHttpServer } from "./httpServer.js";
import { listenServer } from "./listenServer.js";
import { createApiRequestHandler } from "./api/handler.js";
import { authenticateRequest as authenticateWebRequest } from "./auth.js";
import { attachWebSocketServer } from "./ws/server.js";

import { resolveAdsStateDir } from "../../workspace/adsPaths.js";
import { detectWorkspace } from "../../workspace/detector.js";
import { syncWorkspaceTemplates } from "../../workspace/service.js";
import { resolveStateDbPath, getStateDatabase } from "../../state/database.js";
import { HistoryMaintenanceScheduler } from "../../state/historyMaintenance.js";
import { HistoryStore } from "../../utils/historyStore.js";
import { createLogger } from "../../utils/logger.js";
import { CliAgentAvailability } from "../../agents/health/agentAvailability.js";
import { createTaskQueueManager } from "./taskQueue/manager.js";
import { WorkspacePurgeScheduler } from "./taskQueue/purgeScheduler.js";
import { loadCwdStore, persistCwdStore, isLikelyWebProcess, isProcessRunning, wait, sanitizeInput } from "../utils.js";
import { runAdsCommandLine } from "../commandRouter.js";
import { resolveSessionPepper, resolveSessionTtlSeconds, isSessionActiveByTokenHash } from "../auth/sessions.js";
import { startTaskTerminalTelegramRetryLoop } from "../taskNotifications/telegramNotifier.js";
import { AgentScheduleCompiler } from "../../scheduler/compiler.js";
import { SchedulerRuntime } from "../../scheduler/runtime.js";
import { resolveSharedConfig, resolveWebConfig } from "../../config.js";
import { closeSharedDatabases } from "../../utils/shutdown.js";
import { createWebSocketHub } from "./start/webSocketHub.js";
import { SyncEventStore } from "./sync/store.js";
import { WebLaneGenerationStore } from "./sync/laneGeneration.js";
import { DirectoryManager } from "../../telegram/utils/directoryManager.js";
import {
  createWebLaneResources,
} from "./start/webLaneResources.js";
import { preferInMemoryThreadId } from "./ws/threadIds.js";
import { createSessionCacheRegistry } from "./ws/sessionCacheRegistry.js";

const logger = createLogger("WebSocket");

const workspaceCache = new Map<string, string>();
const interruptControllers = new Map<string, AbortController>();
const promptRunEpochs = new Map<string, number>();
const adsStateDir = resolveAdsStateDir();
const stateDbPath = resolveStateDbPath();
const LEGACY_WEB_NAMESPACE = "web";
function migrateLegacyWebLaneNamespaces(): void {
  // Keep the raw legacy namespace available as an archive. Generation one
  // reuses only the already-partitioned web-worker/web-planner keys; never copy
  // an undifferentiated legacy thread id into either active lane.
  try {
    void new HistoryStore({
      storagePath: stateDbPath,
      namespace: LEGACY_WEB_NAMESPACE,
      migrateFromPaths: [path.join(adsStateDir, "web-history.json")],
      maxEntriesPerSession: 200,
      maxTextLength: 64 * 1024,
    });
  } catch {
    // ignore
  }
}

migrateLegacyWebLaneNamespaces();

const cwdStorePath = stateDbPath;
const cwdStore = loadCwdStore(cwdStorePath);

async function ensureWebPidFile(): Promise<{ pidFile: string; cleanupPidFile: () => void }> {
  const runDir = path.join(adsStateDir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const pidFile = path.join(runDir, "web.pid");

  const existing = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
  const existingPid = Number.parseInt(existing, 10);

  if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
    if (isProcessRunning(existingPid)) {
      if (isLikelyWebProcess(existingPid)) {
        logger.info(`terminating existing web server pid ${existingPid} from ${pidFile}`);
        try {
          process.kill(existingPid, "SIGTERM");
        } catch (error) {
          logger.info(`failed to terminate pid ${existingPid}: ${(error as Error).message}`);
        }
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && isProcessRunning(existingPid)) {
          await wait(100);
        }
      } else {
        logger.info(`pid file ${pidFile} points to pid ${existingPid}, but command line is different; leaving it running`);
      }
    } else {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }
  }

  fs.writeFileSync(pidFile, String(process.pid));
  const cleanupPidFile = (): void => {
    try {
      const recorded = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
      if (recorded === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // ignore
    }
  };

  return { pidFile, cleanupPidFile };
}

interface WebShutdownDeps {
  cleanupPidFile: () => void;
  scheduler: { stop: () => void };
  historyMaintenance: { stop: () => void };
  sessionManagers: Array<{ destroy: () => void }>;
}

/**
 * Wire SIGINT/SIGTERM/exit to a graceful shutdown that stops the scheduler, destroys
 * session managers (clearing their cleanup timers), waits (capped) for shared Codex
 * app-server daemons to stop so they are not orphaned, then closes databases and
 * removes the pid file. Mirrors the Telegram bot's cleanup so both entrypoints are
 * symmetric.
 */
function registerWebShutdown(deps: WebShutdownDeps): void {
  let shutdownHandled = false;

  const stopSyncResources = (): void => {
    try {
      deps.scheduler.stop();
    } catch (err) {
      logger.warn(`[shutdown] scheduler.stop failed: ${err instanceof Error ? err.message : err}`);
    }
    try {
      deps.historyMaintenance.stop();
    } catch (err) {
      logger.warn(`[shutdown] historyMaintenance.stop failed: ${err instanceof Error ? err.message : err}`);
    }
    for (const sessionManager of deps.sessionManagers) {
      try {
        sessionManager.destroy();
      } catch (err) {
        logger.warn(`[shutdown] sessionManager.destroy failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownHandled) {
      return;
    }
    shutdownHandled = true;
    stopSyncResources();
    try {
      const mod = await import("../../codex/appServer/daemonRegistry.js");
      await Promise.race([
        mod.getSharedDaemonRegistry().stopAll(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger.warn(`[shutdown] stopAll daemons failed: ${err instanceof Error ? err.message : err}`);
    }
    closeSharedDatabases(logger);
    deps.cleanupPidFile();
  };

  // process.exit() fires "exit" synchronously — only sync best-effort cleanup is possible there.
  process.once("exit", () => {
    if (shutdownHandled) {
      return;
    }
    shutdownHandled = true;
    stopSyncResources();
    closeSharedDatabases(logger);
    deps.cleanupPidFile();
  });
  process.once("SIGINT", () => {
    logger.warn("Received SIGINT, shutting down");
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    logger.warn("Received SIGTERM, shutting down");
    void shutdown().finally(() => process.exit(0));
  });
}

export async function startWebServer(): Promise<void> {
  const workspaceRoot = detectWorkspace();
  const sharedConfig = resolveSharedConfig({
    fallbackAllowedDir: workspaceRoot,
    resolveAllowedDirPaths: true,
    fallbackWhenAllowedDirsEmpty: true,
  });
  const webConfig = resolveWebConfig();
  const allowedDirs = sharedConfig.allowedDirs;
  const directoryManager = new DirectoryManager(allowedDirs);
  const allowedOrigins = parseAllowedOrigins(webConfig.allowedOriginsRaw);
  if (allowedOrigins.size === 0) {
    logger.warn(
      "[Web] ADS_WEB_ALLOWED_ORIGINS 未设置：跨站请求仅放行同源/localhost。" +
        "公网部署（如经 frps 反代）请显式设置 ADS_WEB_ALLOWED_ORIGINS=https://你的域名" +
        "（frps 若不保留 Host 头则必须设置）。",
    );
  }
  const sessionTtlSeconds = resolveSessionTtlSeconds();
  const sessionPepper = resolveSessionPepper();
  const webSessionTimeoutMs = webConfig.sessionTimeoutMs;
  const webSessionCleanupIntervalMs = webConfig.sessionCleanupIntervalMs;
  let sessionCacheRegistry: ReturnType<typeof createSessionCacheRegistry> | null = null;
  const laneResources = createWebLaneResources({
    stateDbPath,
    sessionTimeoutMs: webSessionTimeoutMs,
    sessionCleanupIntervalMs: webSessionCleanupIntervalMs,
    historyMaxEntriesPerSession: webConfig.historyMaxEntriesPerSession,
    historyMaxTextLength: webConfig.historyMaxTextLength,
    plannerCodexModel: webConfig.plannerCodexModel,
    workerSessionManagerOptions: {
      onDispose: ({ userId }) => {
        directoryManager.clearUserCwd(userId);
        sessionCacheRegistry?.clearForUser(userId);
      },
    },
    plannerSessionManagerOptions: {
      onDispose: ({ userId }) => {
        directoryManager.clearUserCwd(userId);
        sessionCacheRegistry?.clearForUser(userId);
      },
    },
  });
  const sessionManager = laneResources.worker.sessionManager;
  const plannerSessionManager = laneResources.planner.sessionManager;
  sessionCacheRegistry = createSessionCacheRegistry({
    workspaceCache,
    cwdStore,
    cwdStorePath,
    persistCwdStore,
    hasActiveSession: (userId) =>
      sessionManager.hasSession(userId) ||
      plannerSessionManager.hasSession(userId),
  });
  const getWorkspaceLock = laneResources.worker.getWorkspaceLock;
  const getPlannerWorkspaceLock = laneResources.planner.getWorkspaceLock;
  const syncEventStore = new SyncEventStore({ stateDbPath });
  const laneGenerationStore = new WebLaneGenerationStore({ stateDbPath });
  const wsHub = createWebSocketHub({
    syncEventStore,
    laneGenerationStore,
  });

  const taskQueueManager = createTaskQueueManager({
    workspaceRoot,
    allowedDirs,
    adsStateDir,
    lockForWorkspace: getWorkspaceLock,
    available: webConfig.taskQueueEnabled,
    autoStart: webConfig.taskQueueAutoStart,
    logger,
    broadcastToSession: wsHub.broadcastToSession,
  });

  startTaskTerminalTelegramRetryLoop({ logger });

  const purgeScheduler = new WorkspacePurgeScheduler({ logger });

  const scheduleCompiler = new AgentScheduleCompiler();
  const scheduler = new SchedulerRuntime();
  scheduler.registerWorkspace(workspaceRoot);
  scheduler.start();
  const historyMaintenance = new HistoryMaintenanceScheduler(
    getStateDatabase(stateDbPath),
    {
      retentionDays: webConfig.historyRetentionDays,
      maxStoredBytes: webConfig.historyMaxStoredBytes,
    },
    webConfig.historyMaintenanceIntervalMs,
  );
  historyMaintenance.start();

  const agentAvailability = new CliAgentAvailability();
  const webAgentIds = Array.from(
    new Set([
      ...sessionManager.getConfiguredAgentIds(),
      ...plannerSessionManager.getConfiguredAgentIds(),
    ]),
  );
  const broadcastAgentsSnapshot = (): void => {
    for (const [ws, meta] of wsHub.clientMetaByWs.entries()) {
      const manager =
        meta.chatSessionId === "planner"
          ? plannerSessionManager
          : sessionManager;
      const currentCwdForUser = manager.getUserCwd(meta.sessionUserId);
      const orchestrator = manager.getOrCreate(meta.sessionUserId, currentCwdForUser);
      const activeAgentId = orchestrator.getActiveAgentId();
	      wsHub.safeSendJson(ws, {
	        type: "agents",
	        activeAgentId,
	        agents: orchestrator.listAgents().map((entry) => {
          const merged = agentAvailability.mergeStatus(entry.metadata.id, entry.status);
          return {
            id: entry.metadata.id,
            name: entry.metadata.name,
            ready: merged.ready,
            error: merged.error,
	          };
	        }),
	        threadId: preferInMemoryThreadId({
	          inMemoryThreadId: orchestrator.getThreadId(),
	          savedThreadId: manager.getSavedThreadId(meta.sessionUserId, activeAgentId),
	        }),
	      });
	    }
	  };
  const startAgentAvailabilityProbe = (): void => {
    void agentAvailability
      .probeAll(webAgentIds)
      .then(() => broadcastAgentsSnapshot())
      .catch((error) => {
        logger.warn(`[Web] Failed to probe agent availability: ${(error as Error).message}`);
      });
  };

  const apiHandler = createApiRequestHandler({
    logger,
    allowedOrigins,
    allowedDirs,
    workspaceRoot,
    sessionTtlSeconds,
    sessionPepper,
    taskQueueAvailable: webConfig.taskQueueEnabled,
    resolveTaskWorkspaceRoot: taskQueueManager.resolveTaskWorkspaceRoot,
    resolveTaskContext: taskQueueManager.resolveTaskContext,
    promoteQueuedTasksToPending: taskQueueManager.promoteQueuedTasksToPending,
    broadcastToSession: wsHub.broadcastToSession,
    scheduleWorkspacePurge: (ctx) => purgeScheduler.schedule(ctx),
    scheduleCompiler,
    scheduler,
    syncEventStore,
    interruptControllers,
    promptRunEpochs,
    workerHistoryStore: laneResources.worker.historyStore,
    plannerHistoryStore: laneResources.planner.historyStore,
    laneGenerationStore,
  });

  const server = createHttpServer({ handleApiRequest: apiHandler, logger });

  attachWebSocketServer({
    server,
    logger,
    config: {
      workspaceRoot,
      allowedDirs,
      maxClients: webConfig.maxClients,
      pingIntervalMs: webConfig.wsPingIntervalMs,
      maxMissedPongs: webConfig.wsMaxMissedPongs,
      maxPayloadBytes: webConfig.wsMaxPayloadBytes,
      traceWsDuplication: webConfig.traceWsDuplication,
    },
    auth: {
      allowedOrigins,
      isOriginAllowed: (req, allowed) => isOriginAllowedForRequest(req, allowed),
      authenticateRequest: (req) => {
        const auth = authenticateWebRequest(req, { sessionTtlSeconds, sessionPepper });
        return auth.ok
          ? { ok: true as const, userId: auth.userId, tokenHash: auth.tokenHash }
          : { ok: false as const };
      },
      revalidateSession: (tokenHash) => isSessionActiveByTokenHash({ tokenHash }),
    },
    agents: {
      agentAvailability,
    },
    state: {
      workspaceCache,
      sessionCacheRegistry,
      directoryManager,
      interruptControllers,
      promptRunEpochs,
      clientMetaByWs: wsHub.clientMetaByWs,
      clients: wsHub.clients,
      cwdStore,
      cwdStorePath,
      persistCwdStore,
      syncEventStore,
      laneGenerationStore,
    },
    sessions: {
      workerSessionManager: sessionManager,
      plannerSessionManager,
      getWorkspaceLock,
      getPlannerWorkspaceLock,
    },
    history: {
      workerHistoryStore: laneResources.worker.historyStore,
      plannerHistoryStore: laneResources.planner.historyStore,
    },
    tasks: {
      ensureTaskContext: taskQueueManager.ensureTaskContext,
      promoteQueuedTasksToPending: taskQueueManager.promoteQueuedTasksToPending,
      broadcastToSession: wsHub.broadcastToSession,
    },
    commands: {
      runAdsCommandLine,
      sanitizeInput: (payload) => sanitizeInput(payload) ?? "",
      syncWorkspaceTemplates,
    },
    scheduler: {
      scheduleCompiler,
      scheduler,
    },
  });

  try {
    syncWorkspaceTemplates();
  } catch (error) {
    logger.warn(`[Web] Failed to sync templates: ${(error as Error).message}`);
  }
  const { cleanupPidFile } = await ensureWebPidFile();
  registerWebShutdown({
    cleanupPidFile,
    scheduler,
    historyMaintenance,
    sessionManagers: [sessionManager, plannerSessionManager],
  });
  await listenServer(server, webConfig.port, webConfig.host);
  logger.info(`WebSocket server listening on ws://${webConfig.host}:${webConfig.port}`);
  logger.info(`Workspace: ${workspaceRoot}`);

  startAgentAvailabilityProbe();
}

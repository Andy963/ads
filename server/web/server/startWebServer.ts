import fs from "node:fs";
import path from "node:path";

import { parseAllowedOrigins, isOriginAllowed } from "../auth/origin.js";
import { createHttpServer } from "./httpServer.js";
import { createApiRequestHandler } from "./api/handler.js";
import { authenticateRequest as authenticateWebRequest } from "./auth.js";
import { attachWebSocketServer } from "./ws/server.js";

import { resolveAdsStateDir } from "../../workspace/adsPaths.js";
import { detectWorkspace } from "../../workspace/detector.js";
import { syncWorkspaceTemplates } from "../../workspace/service.js";
import { resolveStateDbPath, closeAllStateDatabases, getStateDatabase } from "../../state/database.js";
import { closeAllWorkspaceDatabases } from "../../storage/database.js";
import { HistoryStore } from "../../utils/historyStore.js";
import { createLogger } from "../../utils/logger.js";
import { ThreadStorage } from "../../telegram/utils/threadStorage.js";
import { SessionManager } from "../../telegram/utils/sessionManager.js";
import { prepareMigrationMarkerStatements } from "../../state/migrations.js";
import { CliAgentAvailability } from "../../agents/health/agentAvailability.js";
import { createTaskQueueManager } from "./taskQueue/manager.js";
import { WorkspacePurgeScheduler } from "./taskQueue/purgeScheduler.js";
import { WorkspaceLockPool } from "./workspaceLockPool.js";
import { loadCwdStore, persistCwdStore, isLikelyWebProcess, isProcessRunning, resolveAllowedDirs, wait, sanitizeInput } from "../utils.js";
import { runAdsCommandLine } from "../commandRouter.js";
import { resolveSessionPepper, resolveSessionTtlSeconds } from "../auth/sessions.js";
import { startTaskTerminalTelegramRetryLoop } from "../taskNotifications/telegramNotifier.js";
import { AgentScheduleCompiler } from "../../scheduler/compiler.js";
import { SchedulerRuntime } from "../../scheduler/runtime.js";
import { parseBooleanFlag } from "../../utils/flags.js";
import { createWebSocketHub } from "./start/webSocketHub.js";

const PORT = Number(process.env.ADS_WEB_PORT) || 8787;
const HOST = process.env.ADS_WEB_HOST || "127.0.0.1";
// The web UI opens one WebSocket per project/session. Default to a value that enables
// cross-project parallelism out of the box while still being bounded.
const maxClientsRaw = Number(process.env.ADS_WEB_MAX_CLIENTS ?? 32);
const MAX_CLIENTS = Number.isFinite(maxClientsRaw) ? Math.max(1, Math.floor(maxClientsRaw)) : 32;
const pingIntervalMsRaw = Number(process.env.ADS_WEB_WS_PING_INTERVAL_MS ?? 15_000);
const WS_PING_INTERVAL_MS = Number.isFinite(pingIntervalMsRaw) ? Math.max(0, pingIntervalMsRaw) : 15_000;
const maxMissedPongsRaw = Number(process.env.ADS_WEB_WS_MAX_MISSED_PONGS ?? 3);
const WS_MAX_MISSED_PONGS = Number.isFinite(maxMissedPongsRaw) ? Math.max(0, Math.floor(maxMissedPongsRaw)) : 3;

const logger = createLogger("WebSocket");
const allowedOrigins = parseAllowedOrigins(process.env.ADS_WEB_ALLOWED_ORIGINS);
const sessionTtlSeconds = resolveSessionTtlSeconds();
const sessionPepper = resolveSessionPepper();

const workspaceCache = new Map<string, string>();
const interruptControllers = new Map<import("ws").WebSocket, AbortController>();
const adsStateDir = resolveAdsStateDir();
const stateDbPath = resolveStateDbPath();
const LEGACY_WEB_NAMESPACE = "web";
const WEB_WORKER_NAMESPACE = "web-worker";
const WEB_PLANNER_NAMESPACE = "web-planner";
const WEB_REVIEWER_NAMESPACE = "web-reviewer";

function migrateLegacyWebLaneNamespaces(): void {
  try {
    // Best-effort: migrate legacy json stores into state.db under the legacy `web` namespace
    // before copying into the new lane namespaces.
    void new ThreadStorage({
      namespace: LEGACY_WEB_NAMESPACE,
      storagePath: path.join(adsStateDir, "web-threads.json"),
      stateDbPath,
    });
  } catch {
    // ignore
  }
  try {
    void new HistoryStore({
      storagePath: stateDbPath,
      namespace: LEGACY_WEB_NAMESPACE,
      migrateFromPaths: [path.join(adsStateDir, "web-history.json")],
      maxEntriesPerSession: 200,
      maxTextLength: 4000,
    });
  } catch {
    // ignore
  }

  const db = getStateDatabase(stateDbPath);
  const { getMigrationMarkerStmt, setMigrationMarkerStmt } = prepareMigrationMarkerStatements(db);
  const marker = "web_lane_namespaces:v1";
  let markerSet = false;
  try {
    const existing = getMigrationMarkerStmt.get(marker) as { value?: string } | undefined;
    if (existing?.value) {
      markerSet = true;
    }
  } catch {
    // ignore
  }

  if (markerSet) {
    try {
      const existingLaneHistory = db
        .prepare(
          `SELECT 1 as one
           FROM history_entries
           WHERE namespace IN (?, ?)
           LIMIT 1`,
        )
        .get(WEB_WORKER_NAMESPACE, WEB_PLANNER_NAMESPACE) as { one?: number } | undefined;
      if (existingLaneHistory?.one) {
        return;
      }

      const existingLegacyHistory = db
        .prepare(
          `SELECT 1 as one
           FROM history_entries
           WHERE namespace = ?
           LIMIT 1`,
        )
        .get(LEGACY_WEB_NAMESPACE) as { one?: number } | undefined;
      if (!existingLegacyHistory?.one) {
        return;
      }
    } catch {
      // If we cannot safely determine whether a backfill is needed, prefer to avoid duplicating history.
      return;
    }
  }

  const tx = db.transaction(() => {
    const now = Date.now();

    // Thread state: cannot partition by lane (user_hash is irreversible), so copy all.
    for (const target of [WEB_WORKER_NAMESPACE, WEB_PLANNER_NAMESPACE, WEB_REVIEWER_NAMESPACE]) {
      db.prepare(
        `INSERT OR IGNORE INTO thread_state (namespace, user_hash, thread_id, cwd, updated_at)
         SELECT ?, user_hash, thread_id, cwd, updated_at
         FROM thread_state
         WHERE namespace = ?`,
      ).run(target, LEGACY_WEB_NAMESPACE);
    }

    // History: partition by chatSessionId suffix.
    db.prepare(
      `INSERT OR IGNORE INTO history_entries (namespace, session_id, role, text, ts, kind)
       SELECT ?, session_id, role, text, ts, kind
       FROM history_entries
       WHERE namespace = ?
         AND session_id LIKE '%::planner'`,
    ).run(WEB_PLANNER_NAMESPACE, LEGACY_WEB_NAMESPACE);

    db.prepare(
      `INSERT OR IGNORE INTO history_entries (namespace, session_id, role, text, ts, kind)
       SELECT ?, session_id, role, text, ts, kind
       FROM history_entries
       WHERE namespace = ?
          AND session_id NOT LIKE '%::planner'`,
    ).run(WEB_WORKER_NAMESPACE, LEGACY_WEB_NAMESPACE);

    setMigrationMarkerStmt.run(marker, "1", now);
  });

  try {
    tx();
  } catch (error) {
    logger.warn(`[Web] Failed to migrate legacy web lane namespaces: ${(error as Error).message}`);
  }
}

migrateLegacyWebLaneNamespaces();

const webWorkerThreadStorage = new ThreadStorage({
  namespace: WEB_WORKER_NAMESPACE,
});
const webPlannerThreadStorage = new ThreadStorage({
  namespace: WEB_PLANNER_NAMESPACE,
});
const webReviewerThreadStorage = new ThreadStorage({
  namespace: WEB_REVIEWER_NAMESPACE,
});
const PLANNER_CODEX_MODEL = process.env.ADS_PLANNER_CODEX_MODEL?.trim() || undefined;
const REVIEWER_CODEX_MODEL = process.env.ADS_REVIEWER_CODEX_MODEL?.trim() || undefined;

const sessionManager = new SessionManager(0, 0, "danger-full-access", undefined, webWorkerThreadStorage);
const plannerSessionManager = new SessionManager(0, 0, "read-only", PLANNER_CODEX_MODEL, webPlannerThreadStorage);
const reviewerSessionManager = new SessionManager(0, 0, "read-only", REVIEWER_CODEX_MODEL, webReviewerThreadStorage);

const workerHistoryStore = new HistoryStore({
  storagePath: stateDbPath,
  namespace: WEB_WORKER_NAMESPACE,
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const plannerHistoryStore = new HistoryStore({
  storagePath: stateDbPath,
  namespace: WEB_PLANNER_NAMESPACE,
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const reviewerHistoryStore = new HistoryStore({
  storagePath: stateDbPath,
  namespace: WEB_REVIEWER_NAMESPACE,
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = stateDbPath;
const cwdStore = loadCwdStore(cwdStorePath);

async function ensureWebPidFile(): Promise<string> {
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
  const cleanup = (): void => {
    try {
      const recorded = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
      if (recorded === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // ignore
    }
  };
  let shutdownHandled = false;
  const shutdown = (): void => {
    if (shutdownHandled) {
      return;
    }
    shutdownHandled = true;
    try {
      closeAllWorkspaceDatabases();
    } catch {
      // ignore
    }
    try {
      closeAllStateDatabases();
    } catch {
      // ignore
    }
    cleanup();
  };
  process.once("exit", shutdown);
  process.once("SIGINT", () => {
    logger.warn("Received SIGINT, shutting down");
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    logger.warn("Received SIGTERM, shutting down");
    shutdown();
    process.exit(0);
  });

  return pidFile;
}

export async function startWebServer(): Promise<void> {
  const workspaceRoot = detectWorkspace();
  const allowedDirs = resolveAllowedDirs(workspaceRoot);
  const workspaceLocks = new WorkspaceLockPool();
  const plannerWorkspaceLocks = new WorkspaceLockPool();
  const reviewerWorkspaceLocks = new WorkspaceLockPool();
  const getWorkspaceLock = (workspaceRootForLock: string) => workspaceLocks.get(workspaceRootForLock);
  const getPlannerWorkspaceLock = (workspaceRootForLock: string) => plannerWorkspaceLocks.get(workspaceRootForLock);
  const getReviewerWorkspaceLock = (workspaceRootForLock: string) => reviewerWorkspaceLocks.get(workspaceRootForLock);
  const taskQueueAvailable = parseBooleanFlag(process.env.TASK_QUEUE_ENABLED, true);
  const taskQueueAutoStart = parseBooleanFlag(process.env.TASK_QUEUE_AUTO_START, false);

  const traceWsDuplication = parseBooleanFlag(process.env.ADS_TRACE_WS_DUPLICATION, false);
  const wsHub = createWebSocketHub({ workerHistoryStore, reviewerHistoryStore });

  const taskQueueManager = createTaskQueueManager({
    workspaceRoot,
    allowedDirs,
    adsStateDir,
    lockForWorkspace: getWorkspaceLock,
    available: taskQueueAvailable,
    autoStart: taskQueueAutoStart,
    logger,
    broadcastToSession: wsHub.broadcastToSession,
    recordToSessionHistories: wsHub.recordToSessionHistories,
    reviewSessionManager: reviewerSessionManager,
    broadcastToReviewerSession: wsHub.broadcastToReviewerSession,
    recordToReviewerHistories: wsHub.recordToReviewerHistories,
  });

  startTaskTerminalTelegramRetryLoop({ logger });

  const purgeScheduler = new WorkspacePurgeScheduler({ logger });

  const scheduleCompiler = new AgentScheduleCompiler();
  const scheduler = new SchedulerRuntime();
  scheduler.registerWorkspace(workspaceRoot);
  scheduler.start();

  const agentAvailability = new CliAgentAvailability();
  const broadcastAgentsSnapshot = (): void => {
    for (const [ws, meta] of wsHub.clientMetaByWs.entries()) {
      const manager =
        meta.chatSessionId === "planner"
          ? plannerSessionManager
          : meta.chatSessionId === "reviewer"
            ? reviewerSessionManager
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
        threadId: manager.getSavedThreadId(meta.sessionUserId, activeAgentId) ?? orchestrator.getThreadId(),
      });
    }
  };
  const startAgentAvailabilityProbe = (): void => {
    void agentAvailability
      .probeAll()
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
    taskQueueAvailable,
    resolveTaskWorkspaceRoot: taskQueueManager.resolveTaskWorkspaceRoot,
    resolveTaskContext: taskQueueManager.resolveTaskContext,
    promoteQueuedTasksToPending: taskQueueManager.promoteQueuedTasksToPending,
    broadcastToSession: wsHub.broadcastToSession,
    scheduleWorkspacePurge: (ctx) => purgeScheduler.schedule(ctx),
    scheduleCompiler,
    scheduler,
  });

  const server = createHttpServer({ handleApiRequest: apiHandler, logger });

  attachWebSocketServer({
    server,
    workspaceRoot,
    allowedOrigins,
    agentAvailability,
    maxClients: MAX_CLIENTS,
    pingIntervalMs: WS_PING_INTERVAL_MS,
    maxMissedPongs: WS_MAX_MISSED_PONGS,
    logger,
    traceWsDuplication,
    allowedDirs,
    workspaceCache,
    interruptControllers,
    clientMetaByWs: wsHub.clientMetaByWs,
    clients: wsHub.clients,
    cwdStore,
    cwdStorePath,
    persistCwdStore,
    workerSessionManager: sessionManager,
    plannerSessionManager,
    reviewerSessionManager,
    workerHistoryStore,
    plannerHistoryStore,
    reviewerHistoryStore,
    ensureTaskContext: taskQueueManager.ensureTaskContext,
    promoteQueuedTasksToPending: taskQueueManager.promoteQueuedTasksToPending,
    broadcastToSession: wsHub.broadcastToSession,
    getWorkspaceLock,
    getPlannerWorkspaceLock,
    getReviewerWorkspaceLock,
    runAdsCommandLine,
    sanitizeInput: (payload) => sanitizeInput(payload) ?? "",
    syncWorkspaceTemplates,
    scheduleCompiler,
    scheduler,
    isOriginAllowed: (originHeader, allowed) => {
      const normalized =
        typeof originHeader === "string" || Array.isArray(originHeader)
          ? (originHeader as string | string[])
          : undefined;
      return isOriginAllowed(normalized, allowed);
    },
    authenticateRequest: (req) => {
      const auth = authenticateWebRequest(req, { sessionTtlSeconds, sessionPepper });
      return auth.ok ? { ok: true as const, userId: auth.userId } : { ok: false as const };
    },
  });

  try {
    syncWorkspaceTemplates();
  } catch (error) {
    logger.warn(`[Web] Failed to sync templates: ${(error as Error).message}`);
  }
  await ensureWebPidFile();

  server.listen(PORT, HOST, () => {
    logger.info(`WebSocket server listening on ws://${HOST}:${PORT}`);
    logger.info(`Workspace: ${workspaceRoot}`);
  });

  startAgentAvailabilityProbe();
}

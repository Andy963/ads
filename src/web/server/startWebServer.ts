import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseAllowedOrigins, isOriginAllowed } from "../auth/origin.js";
import { createHttpServer } from "./httpServer.js";
import { createApiRequestHandler } from "./api/handler.js";
import { authenticateRequest as authenticateWebRequest } from "./auth.js";
import { attachWebSocketServer } from "./ws/server.js";
import { matchesBroadcastSessionId } from "./ws/session.js";

import { resolveAdsStateDir } from "../../workspace/adsPaths.js";
import { detectWorkspace } from "../../workspace/detector.js";
import { syncWorkspaceTemplates } from "../../workspace/service.js";
import { resolveStateDbPath, closeAllStateDatabases } from "../../state/database.js";
import { closeAllWorkspaceDatabases } from "../../storage/database.js";
import { HistoryStore } from "../../utils/historyStore.js";
import { createLogger } from "../../utils/logger.js";
import { ThreadStorage } from "../../telegram/utils/threadStorage.js";
import { SessionManager } from "../../telegram/utils/sessionManager.js";
import { CliAgentAvailability } from "../../agents/health/agentAvailability.js";
import { createTaskQueueManager } from "./taskQueue/manager.js";
import { WorkspacePurgeScheduler } from "./taskQueue/purgeScheduler.js";
import { WorkspaceLockPool } from "./workspaceLockPool.js";
import { loadCwdStore, persistCwdStore, isLikelyWebProcess, isProcessRunning, resolveAllowedDirs, wait, sanitizeInput } from "../utils.js";
import { runAdsCommandLine } from "../commandRouter.js";
import { resolveSessionPepper, resolveSessionTtlSeconds } from "../auth/sessions.js";
import { createMcpRequestHandler } from "./mcp/handler.js";
import { resolveMcpPepper } from "./mcp/secret.js";
import { taskBundleDraftUpsertTool } from "./mcp/tools/taskBundleDraftTool.js";
import { startTaskTerminalTelegramRetryLoop } from "../taskNotifications/telegramNotifier.js";

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
const webThreadStorage = new ThreadStorage({
  namespace: "web",
  storagePath: path.join(adsStateDir, "web-threads.json"),
});
const PLANNER_CODEX_HOME = process.env.ADS_PLANNER_CODEX_HOME || "/home/andy/.codex-planner";
const plannerCodexEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: PLANNER_CODEX_HOME };
const sessionManager = new SessionManager(0, 0, "workspace-write", "gpt-5.2", webThreadStorage);
const plannerSessionManager = new SessionManager(0, 0, "read-only", "gpt-5.2", webThreadStorage, plannerCodexEnv);
const historyStore = new HistoryStore({
  storagePath: stateDbPath,
  namespace: "web",
  migrateFromPaths: [path.join(adsStateDir, "web-history.json")],
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = stateDbPath;
const cwdStore = loadCwdStore(cwdStorePath);

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

async function ensurePlannerCodexMcpServer(options: { codexHome: string; url: string }): Promise<void> {
  const codexBin = process.env.ADS_CODEX_BIN ?? "codex";
  const removeArgs = ["mcp", "remove", "ads"];
  const addArgs = ["mcp", "add", "ads", "--url", options.url, "--bearer-token-env-var", "ADS_MCP_BEARER_TOKEN"];

  try {
    fs.mkdirSync(options.codexHome, { recursive: true });
  } catch {
    // ignore
  }

  const baseEnv = { ...process.env, CODEX_HOME: options.codexHome };

  await new Promise<void>((resolve) => {
    const child = spawn(codexBin, removeArgs, {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      env: baseEnv,
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve();
    }, 3000);
    timeout.unref?.();
    child.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(codexBin, addArgs, {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      env: baseEnv,
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve(null);
    }, 5000);
    timeout.unref?.();

    child.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    logger.warn(
      `[Web][MCP] Failed to configure planner Codex MCP server (exit=${exitCode ?? "null"}): ${codexBin} ${addArgs.join(" ")}`,
    );
  }
}

async function ensureUserScopedMcpServers(options: { url: string }): Promise<void> {
  const codexBin = process.env.ADS_CODEX_BIN ?? "codex";
  const claudeBin = process.env.ADS_CLAUDE_BIN ?? "claude";
  const geminiBin = process.env.ADS_GEMINI_BIN ?? "gemini";

  const proxyCommandDist = (() => {
    const distCandidate = fileURLToPath(new URL("./mcp/stdioProxy.js", import.meta.url));
    if (fs.existsSync(distCandidate)) {
      return [process.execPath, distCandidate];
    }
    return null;
  })();

  const proxyCommand = proxyCommandDist ?? (() => {
    const srcCandidate = fileURLToPath(new URL("./mcp/stdioProxy.ts", import.meta.url));
    if (fs.existsSync(srcCandidate)) {
      return [process.execPath, "--import", "tsx", srcCandidate];
    }
    return null;
  })();

  const runSilent = async (input: { binary: string; args: string[]; timeoutMs: number }): Promise<number | null> => {
    return await new Promise<number | null>((resolve) => {
      const child = spawn(input.binary, input.args, {
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
      });
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        resolve(null);
      }, input.timeoutMs);
      timeout.unref?.();

      child.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
  };

  const ensureCodex = async (): Promise<void> => {
    await runSilent({ binary: codexBin, args: ["mcp", "remove", "ads"], timeoutMs: 3000 });
    const exitCode = await runSilent({
      binary: codexBin,
      args: ["mcp", "add", "ads", "--url", options.url, "--bearer-token-env-var", "ADS_MCP_BEARER_TOKEN"],
      timeoutMs: 5000,
    });
    if (exitCode !== 0) {
      logger.warn(`[Web][MCP] Failed to configure Codex MCP server (exit=${exitCode ?? "null"})`);
    }
  };

  const ensureClaude = async (): Promise<void> => {
    if (!proxyCommand) {
      logger.warn("[Web][MCP] Skipping Claude MCP bootstrap: proxy command not available");
      return;
    }
    await runSilent({ binary: claudeBin, args: ["mcp", "remove", "--scope", "user", "ads"], timeoutMs: 3000 });
    const exitCode = await runSilent({
      binary: claudeBin,
      args: ["mcp", "add", "--scope", "user", "-e", `ADS_MCP_URL=${options.url}`, "ads", "--", ...proxyCommand],
      timeoutMs: 5000,
    });
    if (exitCode !== 0) {
      logger.warn(`[Web][MCP] Failed to configure Claude MCP server (exit=${exitCode ?? "null"})`);
    }
  };

  const ensureGemini = async (): Promise<void> => {
    if (!proxyCommandDist) {
      logger.warn("[Web][MCP] Skipping Gemini MCP bootstrap: proxy command not available");
      return;
    }
    await runSilent({ binary: geminiBin, args: ["mcp", "remove", "--scope", "user", "ads"], timeoutMs: 3000 });
    const exitCode = await runSilent({
      binary: geminiBin,
      args: ["mcp", "add", "--scope", "user", "--transport", "stdio", "-e", `ADS_MCP_URL=${options.url}`, "ads", ...proxyCommandDist],
      timeoutMs: 5000,
    });
    if (exitCode !== 0) {
      logger.warn(`[Web][MCP] Failed to configure Gemini MCP server (exit=${exitCode ?? "null"})`);
      return;
    }
    await runSilent({ binary: geminiBin, args: ["mcp", "enable", "ads"], timeoutMs: 3000 });
  };

  const bootstrapCodex = parseBooleanFlag(process.env.ADS_CODEX_ENABLED, true);
  const bootstrapClaude = parseBooleanFlag(process.env.ADS_CLAUDE_ENABLED, true);
  const bootstrapGemini = parseBooleanFlag(process.env.ADS_GEMINI_ENABLED, true);

  if (bootstrapCodex) {
    await ensureCodex();
  }
  if (bootstrapClaude) {
    await ensureClaude();
  }
  if (bootstrapGemini) {
    await ensureGemini();
  }
}

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
  const getWorkspaceLock = (workspaceRootForLock: string) => workspaceLocks.get(workspaceRootForLock);
  const getPlannerWorkspaceLock = (workspaceRootForLock: string) => plannerWorkspaceLocks.get(workspaceRootForLock);
  const taskQueueAvailable = parseBooleanFlag(process.env.TASK_QUEUE_ENABLED, true);
  const taskQueueAutoStart = parseBooleanFlag(process.env.TASK_QUEUE_AUTO_START, false);

  const clients: Set<import("ws").WebSocket> = new Set();
  const traceWsDuplication = parseBooleanFlag(process.env.ADS_TRACE_WS_DUPLICATION, false);
  const clientMetaByWs = new Map<
    import("ws").WebSocket,
    {
      historyKey: string;
      sessionId: string;
      chatSessionId: string;
      connectionId: string;
      authUserId: string;
      sessionUserId: number;
      workspaceRoot?: string;
    }
  >();

  const broadcastToSession = (sessionId: string, payload: unknown): void => {
    for (const [ws, meta] of clientMetaByWs.entries()) {
      if (!matchesBroadcastSessionId({
        broadcastSessionId: sessionId,
        connectionSessionId: meta.sessionId,
        connectionWorkspaceRoot: meta.workspaceRoot,
      })) {
        continue;
      }
      if (meta.chatSessionId === "planner") {
        continue;
      }
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // ignore
      }
    }
  };

  const recordToSessionHistories = (
    sessionId: string,
    entry: { role: string; text: string; ts: number; kind?: string },
  ): void => {
    const metas = Array.from(clientMetaByWs.values()).filter((meta) => {
      if (meta.chatSessionId === "planner") {
        return false;
      }
      return matchesBroadcastSessionId({
        broadcastSessionId: sessionId,
        connectionSessionId: meta.sessionId,
        connectionWorkspaceRoot: meta.workspaceRoot,
      });
    });
    const written = new Set<string>();
    for (const meta of metas) {
      if (written.has(meta.historyKey)) {
        continue;
      }
      written.add(meta.historyKey);
      try {
        historyStore.add(meta.historyKey, entry);
      } catch {
        // ignore
      }
    }
  };

  const mcpUrl = `http://127.0.0.1:${PORT}/mcp`;
  const mcpBootstrapEnabled = parseBooleanFlag(process.env.ADS_MCP_BOOTSTRAP_ENABLED, true);
  if (mcpBootstrapEnabled) {
    await ensurePlannerCodexMcpServer({ codexHome: PLANNER_CODEX_HOME, url: mcpUrl });
    await ensureUserScopedMcpServers({ url: mcpUrl });
  }

  const broadcastMcp = (
    auth: { authUserId: string; sessionId: string; chatSessionId: string; historyKey: string; workspaceRoot: string },
    payload: unknown,
  ): void => {
    for (const [ws, meta] of clientMetaByWs.entries()) {
      if (meta.authUserId !== auth.authUserId) continue;
      if (meta.sessionId !== auth.sessionId) continue;
      if (meta.chatSessionId !== auth.chatSessionId) continue;
      if ((ws as { readyState?: number }).readyState !== 1) continue;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // ignore
      }
    }
  };

  const mcpHandler = createMcpRequestHandler({
    pepper: resolveMcpPepper(),
    tools: [taskBundleDraftUpsertTool],
    broadcastPlanner: broadcastMcp,
  });

  const taskQueueManager = createTaskQueueManager({
    workspaceRoot,
    allowedDirs,
    adsStateDir,
    lockForWorkspace: getWorkspaceLock,
    available: taskQueueAvailable,
    autoStart: taskQueueAutoStart,
    logger,
    broadcastToSession,
    recordToSessionHistories,
  });

  startTaskTerminalTelegramRetryLoop({ logger });

  const purgeScheduler = new WorkspacePurgeScheduler({ logger });

  const agentAvailability = new CliAgentAvailability();
  const broadcastAgentsSnapshot = (): void => {
    for (const [ws, meta] of clientMetaByWs.entries()) {
      if ((ws as { readyState?: number }).readyState !== 1) {
        continue;
      }
      const manager = meta.chatSessionId === "planner" ? plannerSessionManager : sessionManager;
      const currentCwdForUser = manager.getUserCwd(meta.sessionUserId);
      const orchestrator = manager.getOrCreate(meta.sessionUserId, currentCwdForUser);
      const activeAgentId = orchestrator.getActiveAgentId();
      try {
        ws.send(JSON.stringify({
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
        }));
      } catch {
        // ignore
      }
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
    resolveTaskContext: taskQueueManager.resolveTaskContext,
    promoteQueuedTasksToPending: taskQueueManager.promoteQueuedTasksToPending,
    broadcastToSession,
    scheduleWorkspacePurge: (ctx) => purgeScheduler.schedule(ctx),
  });

  const server = createHttpServer({ handleApiRequest: apiHandler, handleMcpRequest: mcpHandler });

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
    clientMetaByWs,
    clients,
    cwdStore,
    cwdStorePath,
    persistCwdStore,
    sessionManager,
    plannerSessionManager,
    historyStore,
    ensureTaskContext: taskQueueManager.ensureTaskContext,
    getWorkspaceLock,
    getPlannerWorkspaceLock,
    runAdsCommandLine,
    sanitizeInput: (payload) => sanitizeInput(payload) ?? "",
    syncWorkspaceTemplates,
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

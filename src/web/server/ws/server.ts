import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";

import { getStateDatabase } from "../../../state/database.js";
import { ensureWebAuthTables } from "../../auth/schema.js";
import { ensureWebProjectTables } from "../../projects/schema.js";
import { getWebProjectWorkspaceRoot } from "../../projects/store.js";

import { deriveWebUserId, getWorkspaceState } from "../../utils.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import { wsMessageSchema } from "./schema.js";
import { resolveWebSocketChatSessionId, resolveWebSocketSessionId } from "./session.js";
import { createSafeJsonSend, formatCloseReason, summarizeWsPayloadForLog } from "./utils.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import { handlePromptMessage } from "./handlePrompt.js";
import { handleCommandMessage } from "./handleCommand.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number };

export function attachWebSocketServer(deps: {
  server: import("node:http").Server;
  workspaceRoot: string;
  allowedOrigins: Set<string>;
  agentAvailability: AgentAvailability;
  maxClients: number;
  pingIntervalMs: number;
  maxMissedPongs: number;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
  traceWsDuplication: boolean;
  allowedDirs: string[];
  workspaceCache: Map<string, string>;
  interruptControllers: Map<WebSocket, AbortController>;
  clientMetaByWs: Map<
    WebSocket,
    {
      historyKey: string;
      sessionId: string;
      chatSessionId: string;
      connectionId: string;
      authUserId: string;
      sessionUserId: number;
      workspaceRoot?: string;
    }
  >;
  clients: Set<WebSocket>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: (storePath: string, store: Map<string, string>) => void;
  sessionManager: SessionManager;
  plannerSessionManager: SessionManager;
  historyStore: HistoryStore;
  ensureTaskContext: (workspaceRoot: string) => TaskQueueContext;
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  getPlannerWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sanitizeInput: (payload: unknown) => string;
  syncWorkspaceTemplates: () => void;
  isOriginAllowed: (originHeader: unknown, allowedOrigins: Set<string>) => boolean;
  authenticateRequest: (req: import("node:http").IncomingMessage) => { ok: false } | { ok: true; userId: string };
}): WebSocketServer {
  const wss = new WebSocketServer({ server: deps.server });
  const safeJsonSend = createSafeJsonSend(deps.logger);

  const normalizeWorkspaceRootForMeta = (cwd: string): string => {
    const absolute = path.resolve(String(cwd ?? ""));
    let resolved = absolute;
    try {
      resolved = fs.realpathSync(absolute);
    } catch {
      resolved = absolute;
    }
    const workspaceRootCandidate = detectWorkspaceFrom(resolved);
    let normalized = workspaceRootCandidate;
    try {
      normalized = fs.realpathSync(workspaceRootCandidate);
    } catch {
      normalized = workspaceRootCandidate;
    }
    return normalized;
  };

  wss.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`[WebSocket] server error: ${message}`);
  });

  const sendWorkspaceState = (ws: WebSocket, workspaceRoot: string): void => {
    try {
      const state = getWorkspaceState(workspaceRoot);
      safeJsonSend(ws, { type: "workspace", data: state });
    } catch {
      // ignore
    }
  };

  const pingTimer =
    deps.pingIntervalMs > 0
      ? setInterval(() => {
          for (const ws of deps.clients) {
            const candidate = ws as AliveWebSocket;
            if (candidate.readyState !== 1) {
              continue;
            }
            if (candidate.isAlive === false) {
              candidate.missedPongs = (candidate.missedPongs ?? 0) + 1;
              if (deps.maxMissedPongs > 0 && candidate.missedPongs >= deps.maxMissedPongs) {
                deps.logger.warn(
                  `[WebSocket] terminating stale client connection missedPongs=${candidate.missedPongs} maxMissedPongs=${deps.maxMissedPongs}`,
                );
                try {
                  candidate.terminate();
                } catch {
                  // ignore
                }
                continue;
              }
            } else {
              candidate.missedPongs = 0;
            }
            candidate.isAlive = false;
            try {
              candidate.ping();
            } catch {
              // ignore
            }
          }
        }, deps.pingIntervalMs)
      : null;

  pingTimer?.unref?.();
  wss.on("close", () => {
    if (pingTimer) {
      clearInterval(pingTimer);
    }
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const parsedProtocols = Array.isArray(protocolHeader)
      ? protocolHeader.flatMap((value) => String(value).split(",").map((p) => p.trim()).filter(Boolean))
      : typeof protocolHeader === "string"
        ? protocolHeader.split(",").map((p) => p.trim()).filter(Boolean)
        : [];

    if (!deps.isOriginAllowed(req.headers["origin"], deps.allowedOrigins)) {
      ws.close(4403, "forbidden");
      return;
    }

    const auth = deps.authenticateRequest(req);
    if (!auth.ok) {
      ws.close(4401, "unauthorized");
      return;
    }

    const sessionId = resolveWebSocketSessionId({ protocols: parsedProtocols, workspaceRoot: deps.workspaceRoot });
    const chatSessionId = resolveWebSocketChatSessionId({ protocols: parsedProtocols });
    const isPlannerChat = chatSessionId === "planner";
    const sessionManager = isPlannerChat ? deps.plannerSessionManager : deps.sessionManager;
    const getWorkspaceLock = isPlannerChat ? deps.getPlannerWorkspaceLock : deps.getWorkspaceLock;

    if (deps.clients.size >= deps.maxClients) {
      ws.close(4409, `max clients reached (${deps.maxClients})`);
      return;
    }
    deps.clients.add(ws);
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.missedPongs = 0;
    ws.on("pong", () => {
      aliveWs.isAlive = true;
      aliveWs.missedPongs = 0;
    });

    const authUserId = String(auth.userId ?? "").trim();
    const chatKey = `${sessionId}:${chatSessionId}`;
    const userId = deriveWebUserId(authUserId, chatKey);
    const historyKey = `${authUserId}::${sessionId}::${chatSessionId}`;
    const connectionId = crypto.randomBytes(3).toString("hex");
    deps.clientMetaByWs.set(ws, {
      historyKey,
      sessionId,
      chatSessionId,
      connectionId,
      authUserId,
      sessionUserId: userId,
    });
    const directoryManager = new DirectoryManager(deps.allowedDirs);

    ws.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(
        `[WebSocket] socket error conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId}: ${message}`,
      );
    });

    const cacheKey = `${authUserId}::${sessionId}`;
    const cachedWorkspace = deps.workspaceCache.get(cacheKey);
    const savedState = sessionManager.getSavedState(userId);
    const storedCwd = deps.cwdStore.get(String(userId));
    let currentCwd = directoryManager.getUserCwd(userId);
    const preferredProjectCwd = (() => {
      try {
        const db = getStateDatabase();
        ensureWebAuthTables(db);
        ensureWebProjectTables(db);
        return getWebProjectWorkspaceRoot(db, authUserId, sessionId);
      } catch {
        return null;
      }
    })();

    const preferredCwd = preferredProjectCwd ?? cachedWorkspace ?? savedState?.cwd ?? storedCwd;
    if (preferredCwd) {
      const restoreResult = directoryManager.setUserCwd(userId, preferredCwd);
      if (!restoreResult.success) {
        deps.logger.warn(`[Web][WorkspaceRestore] failed path=${preferredCwd} reason=${restoreResult.error}`);
      } else {
        currentCwd = directoryManager.getUserCwd(userId);
        deps.cwdStore.set(String(userId), currentCwd);
        deps.persistCwdStore(deps.cwdStorePath, deps.cwdStore);
      }
    }
    deps.workspaceCache.set(cacheKey, currentCwd);
    sessionManager.setUserCwd(userId, currentCwd);
    deps.cwdStore.set(String(userId), currentCwd);
    deps.persistCwdStore(deps.cwdStorePath, deps.cwdStore);

    try {
      const meta = deps.clientMetaByWs.get(ws);
      if (meta) {
        meta.workspaceRoot = normalizeWorkspaceRootForMeta(currentCwd);
      }
    } catch {
      // ignore
    }

    const resumeThread = !sessionManager.hasSession(userId);
    let orchestrator = sessionManager.getOrCreate(userId, currentCwd, resumeThread);
    const contextRestored = resumeThread && !sessionManager.needsHistoryInjection(userId);
    const pendingInjection = sessionManager.needsHistoryInjection(userId);

    deps.logger.info(
      `client connected conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId} history=${historyKey} clients=${deps.clients.size}${pendingInjection ? " (pending history injection)" : ""}${contextRestored ? " (thread resumed)" : ""}`,
    );
    const inFlight = deps.interruptControllers.has(ws);

    const broadcastJson = (payload: unknown): void => {
      for (const [candidate, meta] of deps.clientMetaByWs.entries()) {
        if (meta.historyKey !== historyKey) {
          continue;
        }
        safeJsonSend(candidate, payload);
      }
    };

    safeJsonSend(ws, {
      type: "welcome",
      message: "ADS WebSocket bridge ready. Send {type:'command', payload:'/ads.status'}",
      workspace: getWorkspaceState(currentCwd),
      sessionId,
      chatSessionId,
      inFlight,
      threadId: sessionManager.getSavedThreadId(userId, orchestrator.getActiveAgentId()),
      contextMode: pendingInjection ? "history_injection" : contextRestored ? "thread_resumed" : "fresh",
    });
    safeJsonSend(ws, {
      type: "agents",
      activeAgentId: orchestrator.getActiveAgentId(),
      agents: orchestrator.listAgents().map((entry) => {
        const merged = deps.agentAvailability.mergeStatus(entry.metadata.id, entry.status);
        return {
          id: entry.metadata.id,
          name: entry.metadata.name,
          ready: merged.ready,
          error: merged.error,
        };
      }),
      threadId: sessionManager.getSavedThreadId(userId, orchestrator.getActiveAgentId()) ?? orchestrator.getThreadId(),
    });

    const cachedHistory = deps.historyStore.get(historyKey);
    if (cachedHistory.length > 0) {
      const sanitizedHistory = cachedHistory.map((entry) => {
        if (entry.role !== "ai") {
          return entry;
        }
        const cleanedText = stripLeadingTranslation(entry.text);
        if (cleanedText === entry.text) {
          return entry;
        }
        return { ...entry, text: cleanedText };
      });
      const cdPattern = /^\/cd\b/i;
      const isCdCommand = (entry: { role: string; text: string }) =>
        entry.role === "user" && cdPattern.test(String(entry.text ?? "").trim());
      let lastCdIndex = -1;
      for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
        if (isCdCommand(sanitizedHistory[i])) {
          lastCdIndex = i;
          break;
        }
      }
      const filteredHistory =
        lastCdIndex >= 0
          ? sanitizedHistory.filter((entry, idx) => !isCdCommand(entry) || idx === lastCdIndex)
          : sanitizedHistory;
      safeJsonSend(ws, { type: "history", items: filteredHistory });
    }

    let messageChain = Promise.resolve();
    const handleOneMessage = async (data: RawData): Promise<void> => {
      try {
        let parsed: import("./schema.js").WsMessage;
        try {
          const raw = JSON.parse(String(data)) as unknown;
          const result = wsMessageSchema.safeParse(raw);
          if (!result.success) {
            safeJsonSend(ws, { type: "error", message: "Invalid message payload" });
            return;
          }
          parsed = result.data;
        } catch {
          safeJsonSend(ws, { type: "error", message: "Invalid JSON message" });
          return;
        }

        if (parsed.type === "ping") {
          safeJsonSend(ws, { type: "pong", ts: Date.now() });
          return;
        }
        if (parsed.type === "pong") {
          return;
        }

        const requestId = crypto.randomBytes(4).toString("hex");
        const clientMessageIdRaw = String(parsed.client_message_id ?? "").trim();
        const clientMessageId = clientMessageIdRaw || null;
        if (deps.traceWsDuplication) {
          const meta = deps.clientMetaByWs.get(ws);
          const payloadPreview = summarizeWsPayloadForLog(parsed.payload);
          deps.logger.info(
            `[WebSocket][Recv] req=${requestId} conn=${meta?.connectionId ?? "unknown"} session=${sessionId} user=${userId} history=${meta?.historyKey ?? ""} type=${parsed.type} client_message_id=${clientMessageId ?? ""} payload=${payloadPreview}`,
          );
        }

        let sessionLogger: NonNullable<ReturnType<SessionManager["ensureLogger"]>> | null = null;
        try {
          sessionLogger = sessionManager.ensureLogger(userId) ?? null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn(`[WebSocket] Failed to initialize session logger: ${message}`);
          sessionLogger = null;
        }

        if (parsed.type === "interrupt") {
          const controller = deps.interruptControllers.get(ws);
          if (controller) {
            controller.abort();
            deps.interruptControllers.delete(ws);
            safeJsonSend(ws, { type: "result", ok: false, output: "⛔ 已中断，输出可能不完整" });
          } else {
            safeJsonSend(ws, { type: "error", message: "当前没有正在执行的任务" });
          }
          return;
        }

        if (parsed.type === "clear_history") {
          deps.historyStore.clear(historyKey);
          sessionManager.reset(userId);
          safeJsonSend(ws, { type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
          return;
        }

        if (parsed.type === "task_resume") {
          const resume = await handleTaskResumeMessage({
            parsed,
            ws,
            userId,
            historyKey,
            currentCwd,
            ensureTaskContext: deps.ensureTaskContext,
            historyStore: deps.historyStore,
            sessionManager,
            safeJsonSend,
            logger: deps.logger,
            getWorkspaceLock,
            orchestrator,
          });
          if (resume.orchestrator) {
            orchestrator = resume.orchestrator;
          }
          return;
        }

        const promptResult = await handlePromptMessage({
          parsed,
          ws,
          safeJsonSend,
          broadcastJson,
          logger: deps.logger,
          sessionLogger,
          requestId,
          clientMessageId,
          traceWsDuplication: deps.traceWsDuplication,
          authUserId,
          sessionId,
          chatSessionId,
          userId,
          historyKey,
          currentCwd,
          allowedDirs: deps.allowedDirs,
          getWorkspaceLock,
          interruptControllers: deps.interruptControllers,
          historyStore: deps.historyStore,
          sessionManager,
          orchestrator,
          sendWorkspaceState,
        });
        if (promptResult.handled) {
          orchestrator = promptResult.orchestrator;
          return;
        }

        const commandResult = await handleCommandMessage({
          parsed,
          ws,
          safeJsonSend,
          broadcastJson,
          logger: deps.logger,
          sessionLogger,
          requestId,
          sessionId,
          userId,
          historyKey,
          clientMessageId,
          traceWsDuplication: deps.traceWsDuplication,
          agentAvailability: deps.agentAvailability,
          directoryManager,
          cacheKey,
          workspaceCache: deps.workspaceCache,
          cwdStore: deps.cwdStore,
          cwdStorePath: deps.cwdStorePath,
          persistCwdStore: deps.persistCwdStore,
          sessionManager,
          historyStore: deps.historyStore,
          interruptControllers: deps.interruptControllers,
          runAdsCommandLine: deps.runAdsCommandLine,
          sendWorkspaceState,
          syncWorkspaceTemplates: deps.syncWorkspaceTemplates,
          sanitizeInput: deps.sanitizeInput,
          currentCwd,
          orchestrator,
          getWorkspaceLock,
        });
        if (commandResult.handled) {
          orchestrator = commandResult.orchestrator;
          currentCwd = commandResult.currentCwd;
          try {
            const meta = deps.clientMetaByWs.get(ws);
            if (meta) {
              meta.workspaceRoot = normalizeWorkspaceRootForMeta(currentCwd);
            }
          } catch {
            // ignore
          }
          return;
        }

        safeJsonSend(ws, { type: "error", message: "Unsupported message type" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(`[WebSocket] Message handler error: ${message}`);
        safeJsonSend(ws, { type: "error", message: "Internal server error" });
      }
    };

    ws.on("message", (data: RawData) => {
      messageChain = messageChain.then(() => handleOneMessage(data)).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(`[WebSocket] Message chain error: ${message}`);
        safeJsonSend(ws, { type: "error", message: "Internal server error" });
      });
    });

    ws.on("close", (code, reason) => {
      deps.clients.delete(ws);
      deps.interruptControllers.delete(ws);
      const meta = deps.clientMetaByWs.get(ws);
      deps.clientMetaByWs.delete(ws);
      const reasonText = formatCloseReason(reason);
      const suffix = reasonText ? ` reason=${reasonText}` : "";
      deps.logger.info(
        `client disconnected conn=${meta?.connectionId ?? "unknown"} session=${sessionId} user=${userId} history=${meta?.historyKey ?? ""} code=${code}${suffix}`,
      );
    });
  });

  return wss;
}

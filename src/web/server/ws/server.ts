import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import type { TodoListItem } from "@openai/codex-sdk";

import { deriveWebUserId, getWorkspaceState } from "../../utils.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import { wsMessageSchema } from "./schema.js";
import { createSafeJsonSend, formatCloseReason, summarizeWsPayloadForLog } from "./utils.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import { handlePromptMessage } from "./handlePrompt.js";
import { handleCommandMessage } from "./handleCommand.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number };

export function attachWebSocketServer(deps: {
  server: import("node:http").Server;
  allowedOrigins: Set<string>;
  maxClients: number;
  pingIntervalMs: number;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
  traceWsDuplication: boolean;
  allowedDirs: string[];
  workspaceCache: Map<string, string>;
  interruptControllers: Map<number, AbortController>;
  clientMetaByWs: Map<WebSocket, { historyKey: string; sessionId: string; connectionId: string; userId: number }>;
  clients: Set<WebSocket>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: (storePath: string, store: Map<string, string>) => void;
  sessionManager: SessionManager;
  historyStore: HistoryStore;
  ensureTaskContext: (workspaceRoot: string) => TaskQueueContext;
  taskQueueLock: { runExclusive: <T>(fn: () => Promise<T>) => Promise<T> };
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sanitizeInput: (payload: unknown) => string;
  syncWorkspaceTemplates: () => void;
  isOriginAllowed: (originHeader: unknown, allowedOrigins: Set<string>) => boolean;
  authenticateRequest: (req: import("node:http").IncomingMessage) => { ok: false } | { ok: true; userId: string };
}): WebSocketServer {
  const wss = new WebSocketServer({ server: deps.server });
  const safeJsonSend = createSafeJsonSend(deps.logger);
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
              if (candidate.missedPongs >= 3) {
                deps.logger.warn("[WebSocket] terminating stale client connection");
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

  wss.on("connection", (ws: WebSocket, req) => {
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const parsedProtocols =
      Array.isArray(protocolHeader) && protocolHeader.length > 0
        ? protocolHeader
        : typeof protocolHeader === "string"
          ? protocolHeader.split(",").map((p) => p.trim())
          : [];

    const parseProtocols = (protocols: string[]): { session?: string } => {
      let session: string | undefined;
      for (let i = 0; i < protocols.length; i++) {
        const entry = protocols[i];
        if (entry.startsWith("ads-session.")) {
          session = entry.slice("ads-session.".length);
          continue;
        }
        if (entry.startsWith("ads-session:")) {
          session = entry.split(":").slice(1).join(":");
          continue;
        }
        if (entry === "ads-session" && i + 1 < protocols.length) {
          session = protocols[i + 1];
        }
      }
      return { session };
    };

    if (!deps.isOriginAllowed(req.headers["origin"], deps.allowedOrigins)) {
      ws.close(4403, "forbidden");
      return;
    }

    const auth = deps.authenticateRequest(req);
    if (!auth.ok) {
      ws.close(4401, "unauthorized");
      return;
    }

    const { session: wsSession } = parseProtocols(parsedProtocols);
    const sessionId = wsSession && wsSession.trim() ? wsSession.trim() : crypto.randomBytes(4).toString("hex");

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

    const clientKey = String(auth.userId ?? "").trim();
    const userId = deriveWebUserId(clientKey, sessionId);
    const historyKey = `${clientKey}::${sessionId}`;
    const connectionId = crypto.randomBytes(3).toString("hex");
    deps.clientMetaByWs.set(ws, { historyKey, sessionId, connectionId, userId });
    const directoryManager = new DirectoryManager(deps.allowedDirs);

    const cacheKey = `${clientKey}::${sessionId}`;
    const cachedWorkspace = deps.workspaceCache.get(cacheKey);
    const savedState = deps.sessionManager.getSavedState(userId);
    const storedCwd = deps.cwdStore.get(String(userId));
    let currentCwd = directoryManager.getUserCwd(userId);
    const preferredCwd = cachedWorkspace ?? savedState?.cwd ?? storedCwd;
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
    deps.sessionManager.setUserCwd(userId, currentCwd);
    deps.cwdStore.set(String(userId), currentCwd);
    deps.persistCwdStore(deps.cwdStorePath, deps.cwdStore);

    const resumeThread = !deps.sessionManager.hasSession(userId);
    let orchestrator = deps.sessionManager.getOrCreate(userId, currentCwd, resumeThread);
    let lastPlanSignature: string | null = null;
    let lastPlanItems: TodoListItem["items"] | null = null;

    deps.logger.info(
      `client connected conn=${connectionId} session=${sessionId} user=${userId} history=${historyKey} clients=${deps.clients.size}`,
    );
    safeJsonSend(ws, {
      type: "welcome",
      message: "ADS WebSocket bridge ready. Send {type:'command', payload:'/ads.status'}",
      workspace: getWorkspaceState(currentCwd),
      sessionId,
      threadId: deps.sessionManager.getSavedThreadId(userId, orchestrator.getActiveAgentId()),
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

    ws.on("message", async (data: RawData) => {
      aliveWs.isAlive = true;
      aliveWs.missedPongs = 0;
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

      const sessionLogger = deps.sessionManager.ensureLogger(userId) ?? null;

      if (parsed.type === "interrupt") {
        const controller = deps.interruptControllers.get(userId);
        if (controller) {
          controller.abort();
          deps.interruptControllers.delete(userId);
          safeJsonSend(ws, { type: "result", ok: false, output: "⛔ 已中断，输出可能不完整" });
        } else {
          safeJsonSend(ws, { type: "error", message: "当前没有正在执行的任务" });
        }
        return;
      }

      if (parsed.type === "clear_history") {
        deps.historyStore.clear(historyKey);
        deps.sessionManager.reset(userId, { preserveThreadForResume: true });
        safeJsonSend(ws, { type: "result", ok: true, output: "已清空历史缓存并重置会话（可使用“恢复上下文”找回）", kind: "clear_history" });
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
          sessionManager: deps.sessionManager,
          safeJsonSend,
          logger: deps.logger,
          taskQueueLock: deps.taskQueueLock,
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
        logger: deps.logger,
        sessionLogger,
        requestId,
        clientMessageId,
        traceWsDuplication: deps.traceWsDuplication,
        sessionId,
        userId,
        historyKey,
        currentCwd,
        allowedDirs: deps.allowedDirs,
        taskQueueLock: deps.taskQueueLock,
        interruptControllers: deps.interruptControllers,
        historyStore: deps.historyStore,
        sessionManager: deps.sessionManager,
        orchestrator,
        lastPlanSignature,
        lastPlanItems,
        sendWorkspaceState,
      });
      if (promptResult.handled) {
        orchestrator = promptResult.orchestrator;
        lastPlanSignature = promptResult.lastPlanSignature;
        lastPlanItems = promptResult.lastPlanItems;
        return;
      }

      const commandResult = await handleCommandMessage({
        parsed,
        ws,
        safeJsonSend,
        logger: deps.logger,
        sessionLogger,
        requestId,
        sessionId,
        userId,
        historyKey,
        clientMessageId,
        traceWsDuplication: deps.traceWsDuplication,
        directoryManager,
        cacheKey,
        workspaceCache: deps.workspaceCache,
        cwdStore: deps.cwdStore,
        cwdStorePath: deps.cwdStorePath,
        persistCwdStore: deps.persistCwdStore,
        sessionManager: deps.sessionManager,
        historyStore: deps.historyStore,
        interruptControllers: deps.interruptControllers,
        runAdsCommandLine: deps.runAdsCommandLine,
        sendWorkspaceState,
        syncWorkspaceTemplates: deps.syncWorkspaceTemplates,
        sanitizeInput: deps.sanitizeInput,
        currentCwd,
        lastPlanSignature,
        lastPlanItems,
        orchestrator,
        taskQueueLock: deps.taskQueueLock,
      });
      if (commandResult.handled) {
        orchestrator = commandResult.orchestrator;
        currentCwd = commandResult.currentCwd;
        lastPlanSignature = commandResult.lastPlanSignature;
        lastPlanItems = commandResult.lastPlanItems;
        return;
      }

      safeJsonSend(ws, { type: "error", message: "Unsupported message type" });
    });

    ws.on("close", (code, reason) => {
      deps.clients.delete(ws);
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

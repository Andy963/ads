import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";

import { getStateDatabase } from "../../../state/database.js";
import { ensureWebAuthTables } from "../../auth/schema.js";
import { ensureWebProjectTables } from "../../projects/schema.js";
import { getWebProjectWorkspaceRoot } from "../../projects/store.js";

import { deriveLegacyWebUserId, deriveWebUserId, getWorkspaceState } from "../../utils.js";
import { wsMessageSchema } from "./schema.js";
import type { AttachWebSocketServerDeps } from "./deps.js";
import { resolveWebSocketChatSessionId, resolveWebSocketSessionId } from "./session.js";
import { createSafeJsonSend, formatCloseReason, summarizeWsPayloadForLog } from "./utils.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import { handlePromptMessage } from "./handlePrompt.js";
import { handleCommandMessage } from "./handleCommand.js";
import { buildPromptHistoryText } from "./promptHistory.js";
import { resolveWorkspaceRootFromDirectory } from "../api/routes/workspacePath.js";
import { preferInMemoryThreadId } from "./threadIds.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number };

export function attachWebSocketServer(deps: AttachWebSocketServerDeps): WebSocketServer {
  const { auth, agents, commands, config, history, logger, scheduler, sessions, state, tasks } = deps;
  const wss = new WebSocketServer({ server: deps.server });
  const safeJsonSend = createSafeJsonSend(logger);

  const normalizeWorkspaceRootForMeta = (cwd: string): string => {
    return resolveWorkspaceRootFromDirectory(cwd);
  };

  wss.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[WebSocket] server error: ${message}`);
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
    config.pingIntervalMs > 0
      ? setInterval(() => {
          for (const ws of state.clients) {
            const candidate = ws as AliveWebSocket;
            if (candidate.readyState !== 1) {
              continue;
            }
            if (candidate.isAlive === false) {
              candidate.missedPongs = (candidate.missedPongs ?? 0) + 1;
              if (config.maxMissedPongs > 0 && candidate.missedPongs >= config.maxMissedPongs) {
                logger.warn(
                  `[WebSocket] terminating stale client connection missedPongs=${candidate.missedPongs} maxMissedPongs=${config.maxMissedPongs}`,
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
        }, config.pingIntervalMs)
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

    if (!auth.isOriginAllowed(req.headers["origin"], auth.allowedOrigins)) {
      ws.close(4403, "forbidden");
      return;
    }

    const authResult = auth.authenticateRequest(req);
    if (!authResult.ok) {
      ws.close(4401, "unauthorized");
      return;
    }

    const sessionId = resolveWebSocketSessionId({ protocols: parsedProtocols, workspaceRoot: config.workspaceRoot });
    const chatSessionId = resolveWebSocketChatSessionId({ protocols: parsedProtocols });
    const isPlannerChat = chatSessionId === "planner";
    const isReviewerChat = chatSessionId === "reviewer";
    const sessionManager = isPlannerChat
      ? sessions.plannerSessionManager
      : isReviewerChat
        ? sessions.reviewerSessionManager
        : sessions.workerSessionManager;
    const historyStore = isPlannerChat
      ? history.plannerHistoryStore
      : isReviewerChat
        ? history.reviewerHistoryStore
        : history.workerHistoryStore;
    const getWorkspaceLock = isPlannerChat
      ? sessions.getPlannerWorkspaceLock
      : isReviewerChat
        ? sessions.getReviewerWorkspaceLock
        : sessions.getWorkspaceLock;

    if (Number.isFinite(config.maxClients) && config.maxClients > 0 && state.clients.size >= config.maxClients) {
      ws.close(4409, `max clients reached (${config.maxClients})`);
      return;
    }
    state.clients.add(ws);
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.missedPongs = 0;
    ws.on("pong", () => {
      aliveWs.isAlive = true;
      aliveWs.missedPongs = 0;
    });

    const authUserId = String(authResult.userId ?? "").trim();
    const chatKey = `${sessionId}:${chatSessionId}`;
    const legacyUserId = deriveLegacyWebUserId(authUserId, chatKey);
    const userId = deriveWebUserId(authUserId, chatKey);
    sessionManager.maybeMigrateThreadState(legacyUserId, userId);
    const historyKey = `${authUserId}::${sessionId}::${chatSessionId}`;
    const connectionId = crypto.randomBytes(3).toString("hex");
    state.clientMetaByWs.set(ws, {
      historyKey,
      sessionId,
      chatSessionId,
      connectionId,
      authUserId,
      sessionUserId: userId,
    });
    ws.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[WebSocket] socket error conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId}: ${message}`,
      );
    });

    const cacheKey = `${authUserId}::${sessionId}`;
    const registerSessionCacheBinding = (): void => {
      state.sessionCacheRegistry.registerBinding({
        userId,
        cacheKey,
        cwdKeys: [String(userId), String(legacyUserId)],
      });
    };
    registerSessionCacheBinding();
    const cachedWorkspace = state.workspaceCache.get(cacheKey);
    const userCwdKey = String(userId);
    if (!state.cwdStore.has(userCwdKey)) {
      const legacyCwd = state.cwdStore.get(String(legacyUserId));
      if (legacyCwd && legacyCwd.trim()) {
        state.cwdStore.set(userCwdKey, legacyCwd);
        state.persistCwdStore(state.cwdStorePath, state.cwdStore);
      }
    }
    const savedState = sessionManager.getSavedState(userId);
    const storedCwd = state.cwdStore.get(userCwdKey);
    let currentCwd = state.directoryManager.getUserCwd(userId);
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
      const restoreResult = state.directoryManager.setUserCwd(userId, preferredCwd);
      if (!restoreResult.success) {
        logger.warn(`[Web][WorkspaceRestore] failed path=${preferredCwd} reason=${restoreResult.error}`);
      } else {
        currentCwd = state.directoryManager.getUserCwd(userId);
        state.cwdStore.set(String(userId), currentCwd);
        state.persistCwdStore(state.cwdStorePath, state.cwdStore);
      }
    }
    state.workspaceCache.set(cacheKey, currentCwd);
    sessionManager.setUserCwd(userId, currentCwd);
    state.cwdStore.set(String(userId), currentCwd);
    state.persistCwdStore(state.cwdStorePath, state.cwdStore);

    try {
      const meta = state.clientMetaByWs.get(ws);
      if (meta) {
        meta.workspaceRoot = normalizeWorkspaceRootForMeta(currentCwd);
      }
    } catch {
      // ignore
    }

    const resumeThread = !isReviewerChat && !sessionManager.hasSession(userId);
    let orchestrator = sessionManager.getOrCreate(userId, currentCwd, resumeThread);
    const contextRestored = resumeThread && !sessionManager.needsHistoryInjection(userId);
    const pendingInjection = sessionManager.needsHistoryInjection(userId);

    logger.info(
      `client connected conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId} history=${historyKey} clients=${state.clients.size}${pendingInjection ? " (pending history injection)" : ""}${contextRestored ? " (thread resumed)" : ""}`,
    );
    const inFlight = state.interruptControllers.has(historyKey);

    const broadcastJson = (payload: unknown): void => {
      for (const [candidate, meta] of state.clientMetaByWs.entries()) {
        if (meta.historyKey !== historyKey) {
          continue;
        }
        safeJsonSend(candidate, payload);
      }
    };

    const abortInFlightForHistoryKey = (targetHistoryKey: string): boolean => {
      const controller = state.interruptControllers.get(targetHistoryKey);
      if (!controller) {
        return false;
      }
      try {
        controller.abort();
      } catch {
        // ignore
      }
      return true;
    };

	    safeJsonSend(ws, {
	      type: "welcome",
	      message: "ADS WebSocket bridge ready.",
	      workspace: getWorkspaceState(currentCwd),
	      sessionId,
	      chatSessionId,
	      inFlight,
	      threadId: preferInMemoryThreadId({
	        inMemoryThreadId: orchestrator.getThreadId(),
	        savedThreadId: sessionManager.getSavedThreadId(userId, orchestrator.getActiveAgentId()),
	      }),
	      contextMode: pendingInjection ? "history_injection" : contextRestored ? "thread_resumed" : "fresh",
	    });
	    safeJsonSend(ws, {
	      type: "agents",
	      activeAgentId: orchestrator.getActiveAgentId(),
      agents: orchestrator.listAgents().map((entry) => {
        const merged = agents.agentAvailability.mergeStatus(entry.metadata.id, entry.status);
        return {
          id: entry.metadata.id,
          name: entry.metadata.name,
          ready: merged.ready,
	          error: merged.error,
	        };
	      }),
	      threadId: preferInMemoryThreadId({
	        inMemoryThreadId: orchestrator.getThreadId(),
	        savedThreadId: sessionManager.getSavedThreadId(userId, orchestrator.getActiveAgentId()),
	      }),
	    });

    const cachedHistory = historyStore.get(historyKey);
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
    let lastReceivedAt = 0;
    type IncomingWsMessage = {
      parsed: import("./schema.js").WsMessage;
      requestId: string;
      clientMessageId: string | null;
      receivedAt: number;
    };

    const shouldPersistCommandMessage = (payload: unknown): { ok: boolean; command: string; shouldPersist: boolean } => {
      const commandRaw = commands.sanitizeInput(payload);
      if (!commandRaw) {
        return { ok: false, command: "", shouldPersist: false };
      }
      const command = commandRaw.trim();
      if (!command) {
        return { ok: false, command: "", shouldPersist: false };
      }
      const isSilent =
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>).silent === true;
      const isCd = /^\/cd\b/i.test(command);
      return { ok: true, command, shouldPersist: !isSilent && !isCd };
    };

    const preflightPersistAndAck = (args: {
      parsed: import("./schema.js").WsMessage;
      requestId: string;
      clientMessageId: string | null;
      receivedAt: number;
    }): { enqueue: boolean } => {
      if (!args.clientMessageId) {
        return { enqueue: true };
      }
      const entryKind = `client_message_id:${args.clientMessageId}`;
      if (args.parsed.type === "prompt") {
        const textResult = buildPromptHistoryText(args.parsed.payload, commands.sanitizeInput);
        if (!textResult.ok) {
          return { enqueue: true };
        }
        const inserted = historyStore.add(historyKey, {
          role: "user",
          text: textResult.text,
          ts: args.receivedAt,
          kind: entryKind,
        });
        safeJsonSend(ws, { type: "ack", client_message_id: args.clientMessageId, duplicate: !inserted });
        if (!inserted) {
          if (config.traceWsDuplication) {
            logger.warn(
              `[WebSocket][Dedupe] req=${args.requestId} session=${sessionId} user=${userId} history=${historyKey} client_message_id=${args.clientMessageId}`,
            );
          }
          return { enqueue: false };
        }
        return { enqueue: true };
      }

      if (args.parsed.type === "command") {
        const cmd = shouldPersistCommandMessage(args.parsed.payload);
        if (!cmd.ok || !cmd.shouldPersist) {
          return { enqueue: true };
        }
        const inserted = historyStore.add(historyKey, {
          role: "user",
          text: cmd.command,
          ts: args.receivedAt,
          kind: entryKind,
        });
        safeJsonSend(ws, { type: "ack", client_message_id: args.clientMessageId, duplicate: !inserted });
        if (!inserted) {
          if (config.traceWsDuplication) {
            logger.warn(
              `[WebSocket][Dedupe] req=${args.requestId} session=${sessionId} user=${userId} history=${historyKey} client_message_id=${args.clientMessageId}`,
            );
          }
          return { enqueue: false };
        }
        return { enqueue: true };
      }

      return { enqueue: true };
    };

    const handleOneMessage = async (msg: IncomingWsMessage): Promise<void> => {
      try {
        registerSessionCacheBinding();
        const parsed = msg.parsed;
        const requestId = msg.requestId;
        const clientMessageId = msg.clientMessageId;

        let sessionLogger: NonNullable<ReturnType<SessionManager["ensureLogger"]>> | null = null;
        try {
          sessionLogger = sessionManager.ensureLogger(userId) ?? null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`[WebSocket] Failed to initialize session logger: ${message}`);
          sessionLogger = null;
        }

        if (parsed.type === "interrupt") {
          const found = abortInFlightForHistoryKey(historyKey);
          if (!found) {
            safeJsonSend(ws, { type: "error", message: "当前没有正在执行的任务" });
          }
          return;
        }

        if (parsed.type === "clear_history") {
          historyStore.clear(historyKey);
          sessionManager.reset(userId);
          safeJsonSend(ws, { type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
          return;
        }

        if (parsed.type === "task_resume") {
          if (isReviewerChat) {
            safeJsonSend(ws, { type: "error", message: "Reviewer lane does not support resuming threads." });
            return;
          }
          const resume = await handleTaskResumeMessage({
            request: {
              parsed,
            },
            transport: {
              ws,
              safeJsonSend,
            },
            observability: {
              logger,
            },
            context: {
              userId,
              historyKey,
              currentCwd,
            },
            sessions: {
              sessionManager,
              orchestrator,
              getWorkspaceLock,
            },
            history: {
              historyStore,
            },
            tasks: {
              ensureTaskContext: tasks.ensureTaskContext,
            },
          });
          if (resume.orchestrator) {
            orchestrator = resume.orchestrator;
          }
          return;
        }

        const promptResult = await handlePromptMessage({
          request: {
            parsed,
            requestId,
            clientMessageId,
            receivedAt: msg.receivedAt,
          },
          transport: {
            ws,
            safeJsonSend,
            broadcastJson,
            sendWorkspaceState,
          },
          observability: {
            logger,
            sessionLogger,
            traceWsDuplication: config.traceWsDuplication,
          },
          context: {
            authUserId,
            sessionId,
            chatSessionId,
            userId,
            historyKey,
            currentCwd,
          },
          sessions: {
            sessionManager,
            orchestrator,
            getWorkspaceLock,
            interruptControllers: state.interruptControllers,
          },
          history: {
            historyStore,
          },
          tasks: {
            ensureTaskContext: tasks.ensureTaskContext,
            promoteQueuedTasksToPending: tasks.promoteQueuedTasksToPending,
            broadcastToSession: tasks.broadcastToSession,
          },
          scheduler,
        });
        if (promptResult.handled) {
          orchestrator = promptResult.orchestrator;
          return;
        }

        if (isReviewerChat && (parsed.type === "command" || parsed.type === "set_agent")) {
          safeJsonSend(ws, { type: "error", message: "Reviewer lane is read-only and does not accept commands." });
          return;
        }

        const commandResult = await handleCommandMessage({
          request: {
            parsed,
            clientMessageId,
          },
          transport: {
            ws,
            safeJsonSend,
            broadcastJson,
            sendWorkspaceState,
          },
          observability: {
            logger,
            sessionLogger,
            traceWsDuplication: config.traceWsDuplication,
          },
          context: {
            sessionId,
            userId,
            historyKey,
            currentCwd,
          },
          agents: {
            agentAvailability: agents.agentAvailability,
          },
          state: {
            directoryManager: state.directoryManager,
            cacheKey,
            workspaceCache: state.workspaceCache,
            cwdStore: state.cwdStore,
            cwdStorePath: state.cwdStorePath,
            persistCwdStore: state.persistCwdStore,
          },
          sessions: {
            sessionManager,
            orchestrator,
            getWorkspaceLock,
            interruptControllers: state.interruptControllers,
          },
          history: {
            historyStore,
          },
          commands,
        });
        if (commandResult.handled) {
          orchestrator = commandResult.orchestrator;
          currentCwd = commandResult.currentCwd;
          try {
            const meta = state.clientMetaByWs.get(ws);
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
        logger.warn(`[WebSocket] Message handler error: ${message}`);
        safeJsonSend(ws, { type: "error", message: "Internal server error" });
      }
    };

    ws.on("message", (data: RawData) => {
      const now = Date.now();
      const receivedAt = now > lastReceivedAt ? now : lastReceivedAt + 1;
      lastReceivedAt = receivedAt;

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
        safeJsonSend(ws, { type: "pong", ts: receivedAt });
        return;
      }
      if (parsed.type === "pong") {
        return;
      }

      if (parsed.type === "interrupt") {
        const found = abortInFlightForHistoryKey(historyKey);
        if (!found) {
          safeJsonSend(ws, { type: "error", message: "当前没有正在执行的任务" });
        }
        return;
      }

      const requestId = crypto.randomBytes(4).toString("hex");
      const clientMessageIdRaw = String(parsed.client_message_id ?? "").trim();
      const clientMessageId = clientMessageIdRaw || null;
      if (config.traceWsDuplication) {
        const meta = state.clientMetaByWs.get(ws);
        const payloadPreview = summarizeWsPayloadForLog(parsed.payload);
        logger.info(
          `[WebSocket][Recv] req=${requestId} conn=${meta?.connectionId ?? "unknown"} session=${sessionId} user=${userId} history=${meta?.historyKey ?? ""} type=${parsed.type} client_message_id=${clientMessageId ?? ""} payload=${payloadPreview}`,
        );
      }

      const preflight = preflightPersistAndAck({ parsed, requestId, clientMessageId, receivedAt });
      if (!preflight.enqueue) {
        return;
      }

      const msg: IncomingWsMessage = { parsed, requestId, clientMessageId, receivedAt };
      messageChain = messageChain.then(() => handleOneMessage(msg)).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[WebSocket] Message chain error: ${message}`);
        safeJsonSend(ws, { type: "error", message: "Internal server error" });
      });
    });

    ws.on("close", (code, reason) => {
      state.clients.delete(ws);
      const meta = state.clientMetaByWs.get(ws);
      if (meta?.historyKey) {
        const controller = state.interruptControllers.get(meta.historyKey);
        if (controller) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
          state.interruptControllers.delete(meta.historyKey);
        }
      }
      state.clientMetaByWs.delete(ws);
      const reasonText = formatCloseReason(reason);
      const suffix = reasonText ? ` reason=${reasonText}` : "";
      logger.info(
        `client disconnected conn=${meta?.connectionId ?? "unknown"} session=${sessionId} user=${userId} history=${meta?.historyKey ?? ""} code=${code}${suffix}`,
      );
    });
  });

  return wss;
}

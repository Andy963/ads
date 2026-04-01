import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

import { getStateDatabase } from "../../../state/database.js";
import { ensureWebAuthTables } from "../../auth/schema.js";
import { ensureWebProjectTables } from "../../projects/schema.js";
import { getWebProjectWorkspaceRoot } from "../../projects/store.js";
import { getWorkspaceState } from "../../utils.js";
import type { AttachWebSocketServerDeps } from "./deps.js";
import { handleImmediateWsMessage, parseIncomingWsEnvelope } from "./messageIntake.js";
import { resolveWebSocketChatSessionId, resolveWebSocketSessionId } from "./session.js";
import { createSafeJsonSend, summarizeWsPayloadForLog } from "./utils.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import { handlePromptMessage } from "./handlePrompt.js";
import { handleCommandMessage } from "./handleCommand.js";
import { resolveWorkspaceRootFromDirectory } from "../api/routes/workspacePath.js";
import { buildAgentsPayload, buildWelcomePayload, buildWsBootstrapState } from "./bootstrapState.js";
import { buildHistoryBootstrapPayload, buildReviewerBootstrapPayloads } from "./bootstrapReplay.js";
import { restoreConnectionWorkspace } from "./connectionWorkspace.js";
import { buildWsConnectionIdentity } from "./connectionIdentity.js";
import { abortInFlightHistory, broadcastJsonToHistoryKey, cleanupClosedConnection } from "./connectionRuntime.js";
import { resolveWsLaneResources } from "./laneResources.js";
import { preflightPersistAndAck } from "./preflight.js";
import { toReviewArtifactSummary } from "../../../tasks/reviewStore.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number };

export function attachWebSocketServer(deps: AttachWebSocketServerDeps): WebSocketServer {
  const { auth, agents, commands, config, history, logger, scheduler, sessions, state, tasks } = deps;
  const wss = new WebSocketServer({ server: deps.server });
  const safeJsonSend = createSafeJsonSend(logger);
  const reviewerSnapshotBindings = new Map<string, string>();

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
    const { isReviewerChat, sessionManager, historyStore, getWorkspaceLock } = resolveWsLaneResources({
      chatSessionId,
      sessions,
      history,
    });

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

    const {
      authUserId,
      legacyUserId,
      userId,
      historyKey,
      connectionId,
      cacheKey,
      clientMeta,
    } = buildWsConnectionIdentity({
      authUserId: authResult.userId,
      sessionId,
      chatSessionId,
    });
    sessionManager.maybeMigrateThreadState(legacyUserId, userId);
    state.clientMetaByWs.set(ws, clientMeta);
    ws.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[WebSocket] socket error conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId}: ${message}`,
      );
    });

    const registerSessionCacheBinding = (): void => {
      state.sessionCacheRegistry.registerBinding({
        userId,
        cacheKey,
        cwdKeys: [String(userId), String(legacyUserId)],
      });
    };
    registerSessionCacheBinding();
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
    let currentCwd = restoreConnectionWorkspace({
      userId,
      legacyUserId,
      cacheKey,
      preferredProjectCwd,
      directoryManager: state.directoryManager,
      sessionManager,
      workspaceCache: state.workspaceCache,
      cwdStore: state.cwdStore,
      cwdStorePath: state.cwdStorePath,
      persistCwdStore: state.persistCwdStore,
      warn: logger.warn,
    });

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
    const contextMode = sessionManager.getContextRestoreMode(userId);

    logger.info(
      `client connected conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId} history=${historyKey} clients=${state.clients.size}${contextMode === "history_injection" ? " (pending history injection)" : ""}${contextMode === "thread_resumed" ? " (thread resumed)" : ""}`,
    );
    const inFlight = state.interruptControllers.has(historyKey);

    const broadcastJson = (payload: unknown): void =>
      broadcastJsonToHistoryKey({
        clientMetaByWs: state.clientMetaByWs,
        historyKey,
        payload,
        sendJson: safeJsonSend,
      });

    const abortInFlightForHistoryKey = (targetHistoryKey: string): boolean =>
      abortInFlightHistory({
        interruptControllers: state.interruptControllers,
        historyKey: targetHistoryKey,
      });

    const bootstrapState = buildWsBootstrapState({
      sessionManager,
      orchestrator,
      userId,
      agentAvailability: agents.agentAvailability,
    });
    safeJsonSend(
      ws,
      buildWelcomePayload({
        sessionId,
        chatSessionId,
        workspace: getWorkspaceState(currentCwd),
        inFlight,
        state: bootstrapState,
      }),
    );
    safeJsonSend(
      ws,
      buildAgentsPayload({
        activeAgentId: orchestrator.getActiveAgentId(),
        state: bootstrapState,
      }),
    );

    const historyPayload = buildHistoryBootstrapPayload(historyStore.get(historyKey));
    if (historyPayload) {
      safeJsonSend(ws, historyPayload);
    }

    const boundSnapshotId = String(reviewerSnapshotBindings.get(historyKey) ?? "").trim() || null;
    const reviewerBootstrapPayloads = buildReviewerBootstrapPayloads({
      isReviewerChat,
      boundSnapshotId,
      latestArtifact: (() => {
        if (!isReviewerChat || !boundSnapshotId) {
          return null;
        }
        try {
          const taskCtx = tasks.ensureTaskContext(normalizeWorkspaceRootForMeta(currentCwd));
          const latestArtifact = taskCtx.reviewStore.getLatestArtifact({ snapshotId: boundSnapshotId });
          return latestArtifact ? toReviewArtifactSummary(latestArtifact) : null;
        } catch {
          return null;
        }
      })(),
    });
    for (const payload of reviewerBootstrapPayloads) {
      safeJsonSend(ws, payload);
    }

    let messageChain = Promise.resolve();
    let lastReceivedAt = 0;
    type IncomingWsMessage = {
      parsed: import("./schema.js").WsMessage;
      requestId: string;
      clientMessageId: string | null;
      receivedAt: number;
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
          if (isReviewerChat) {
            reviewerSnapshotBindings.delete(historyKey);
          }
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
          reviewerSnapshotBindings,
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
      const envelope = parseIncomingWsEnvelope({ data, lastReceivedAt });
      lastReceivedAt = envelope.nextReceivedAt;
      if (!envelope.ok) {
        safeJsonSend(ws, { type: "error", message: envelope.errorMessage });
        return;
      }

      const { parsed, receivedAt, clientMessageId } = envelope;
      if (
        handleImmediateWsMessage({
          parsed,
          receivedAt,
          abortInFlight: () => abortInFlightForHistoryKey(historyKey),
          sendJson: (payload) => safeJsonSend(ws, payload),
        })
      ) {
        return;
      }

      const requestId = crypto.randomBytes(4).toString("hex");
      if (config.traceWsDuplication) {
        const meta = state.clientMetaByWs.get(ws);
        const payloadPreview = summarizeWsPayloadForLog(parsed.payload);
        logger.info(
          `[WebSocket][Recv] req=${requestId} conn=${meta?.connectionId ?? "unknown"} session=${sessionId} user=${userId} history=${meta?.historyKey ?? ""} type=${parsed.type} client_message_id=${clientMessageId ?? ""} payload=${payloadPreview}`,
        );
      }

      const preflight = preflightPersistAndAck({
        parsed,
        requestId,
        clientMessageId,
        receivedAt,
        historyStore,
        historyKey,
        sanitizeInput: commands.sanitizeInput,
        sendJson: (payload) => safeJsonSend(ws, payload),
        traceWsDuplication: config.traceWsDuplication,
        warn: logger.warn,
        sessionId,
        userId,
      });
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
      cleanupClosedConnection({
        ws,
        code,
        reason,
        sessionId,
        userId,
        clients: state.clients,
        clientMetaByWs: state.clientMetaByWs,
        interruptControllers: state.interruptControllers,
        logger,
      });
    });
  });

  return wss;
}

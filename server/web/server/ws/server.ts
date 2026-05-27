import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { getStateDatabase } from "../../../state/database.js";
import { ensureWebAuthTables } from "../../auth/schema.js";
import { ensureWebProjectTables } from "../../projects/schema.js";
import { getWebProjectWorkspaceRoot } from "../../projects/store.js";
import { getWorkspaceState } from "../../utils.js";
import type { AttachWebSocketServerDeps } from "./deps.js";
import { dispatchWsMessage, type IncomingWsMessage } from "./messageDispatch.js";
import { handleImmediateWsMessage, parseIncomingWsEnvelope } from "./messageIntake.js";
import { resolveWebSocketChatSessionId, resolveWebSocketSessionId } from "./session.js";
import { createSafeJsonSend, summarizeWsPayloadForLog } from "./utils.js";
import { resolveWorkspaceRootFromDirectory } from "../api/routes/workspacePath.js";
import { sendInitialBootstrapMessages } from "./bootstrapDelivery.js";
import { restoreConnectionWorkspace } from "./connectionWorkspace.js";
import { buildWsConnectionIdentity } from "./connectionIdentity.js";
import { abortInFlightHistory, broadcastJsonToHistoryKey, cleanupClosedConnection } from "./connectionRuntime.js";
import { resolveWsLaneResources } from "./laneResources.js";
import { preflightPersistAndAck } from "./preflight.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number };

export function attachWebSocketServer(deps: AttachWebSocketServerDeps): WebSocketServer {
  const { auth, agents, commands, config, history, logger, scheduler, sessions, state, tasks } = deps;
  const wss = new WebSocketServer({ server: deps.server });
  const safeJsonSend = createSafeJsonSend(logger);
  const seenChatSessionIdsBySharedSession = new Map<string, Set<string>>();

  const normalizeWorkspaceRootForMeta = (cwd: string): string => {
    return resolveWorkspaceRootFromDirectory(cwd);
  };

  const getSharedSessionRegistryKey = (authUserId: string, sessionId: string): string =>
    `${String(authUserId ?? "").trim()}::${String(sessionId ?? "").trim()}`;

  const registerSeenChatSessionId = (authUserId: string, sessionId: string, chatSessionId: string): void => {
    const registryKey = getSharedSessionRegistryKey(authUserId, sessionId);
    const normalizedChatSessionId = String(chatSessionId ?? "").trim();
    if (!registryKey || !normalizedChatSessionId) {
      return;
    }
    const existing = seenChatSessionIdsBySharedSession.get(registryKey);
    if (existing) {
      existing.add(normalizedChatSessionId);
      return;
    }
    seenChatSessionIdsBySharedSession.set(registryKey, new Set(["main", "planner", normalizedChatSessionId]));
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
    const { sessionManager, historyStore, getWorkspaceLock } = resolveWsLaneResources({
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
    registerSeenChatSessionId(authUserId, sessionId, chatSessionId);
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

    const resumeThread = !sessionManager.hasSession(userId);
    let orchestrator = sessionManager.getOrCreate(userId, currentCwd, resumeThread);
    const contextMode = sessionManager.getContextRestoreMode(userId);

    logger.info(
      `client connected conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId} history=${historyKey} clients=${state.clients.size} restore=${contextMode}${contextMode === "history_injection" ? " (pending history injection)" : ""}${contextMode === "thread_resumed" ? " (thread resumed)" : ""}`,
    );
    const inFlight = state.interruptControllers.has(historyKey);

    const broadcastJson = (payload: unknown): void =>
      broadcastJsonToHistoryKey({
        clientMetaByWs: state.clientMetaByWs,
        historyKey,
        payload,
        sendJson: safeJsonSend,
      });

    const broadcastSessionReset = (payload: unknown): void => {
      const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
      const resetScope = String(payloadRecord.scope ?? "").trim().toLowerCase();
      const sourceChatSessionId = String(payloadRecord.sourceChatSessionId ?? "").trim();
      for (const [candidate, meta] of state.clientMetaByWs.entries()) {
        if (candidate === ws) {
          continue;
        }
        if (meta.authUserId !== authUserId || meta.sessionId !== sessionId) {
          continue;
        }
        if (resetScope !== "shared" && sourceChatSessionId && meta.chatSessionId !== sourceChatSessionId) {
          continue;
        }
        safeJsonSend(candidate, payload);
      }
    };

    const getTrackedSharedChatSessionIds = (): string[] => {
      const registryKey = getSharedSessionRegistryKey(authUserId, sessionId);
      const tracked = new Set<string>(["main", "planner"]);
      for (const seenChatSessionId of seenChatSessionIdsBySharedSession.get(registryKey) ?? []) {
        tracked.add(seenChatSessionId);
      }
      for (const meta of state.clientMetaByWs.values()) {
        if (meta.authUserId !== authUserId || meta.sessionId !== sessionId) {
          continue;
        }
        const candidateChatSessionId = String(meta.chatSessionId ?? "").trim();
        if (candidateChatSessionId) {
          tracked.add(candidateChatSessionId);
        }
      }
      return [...tracked];
    };

    const abortInFlightForHistoryKey = (targetHistoryKey: string): boolean =>
      abortInFlightHistory({
        interruptControllers: state.interruptControllers,
        promptRunEpochs: state.promptRunEpochs,
        historyKey: targetHistoryKey,
      });

    const resetSharedSessionState = (_options: {
      sourceChatSessionId: string;
    }): void => {
      const trackedSharedLanes = getTrackedSharedChatSessionIds().map((trackedChatSessionId) => {
        const { sessionManager: trackedSessionManager, historyStore: trackedHistoryStore } = resolveWsLaneResources({
          chatSessionId: trackedChatSessionId,
          sessions,
          history,
        });
        const identity = buildWsConnectionIdentity({
          authUserId,
          sessionId,
          chatSessionId: trackedChatSessionId,
          randomHex: () => "",
        });
        return {
          chatSessionId: trackedChatSessionId,
          sessionManager: trackedSessionManager,
          historyStore: trackedHistoryStore,
          identity,
        };
      });

      for (const { chatSessionId, sessionManager, historyStore, identity } of trackedSharedLanes) {
        void chatSessionId;
        abortInFlightForHistoryKey(identity.historyKey);
        historyStore.clear(identity.historyKey);
        sessionManager.reset(identity.userId);
        sessionManager.reset(identity.legacyUserId);
      }
    };

    sendInitialBootstrapMessages({
      ws,
      safeJsonSend,
      sessionManager,
      orchestrator,
      userId,
      agentAvailability: agents.agentAvailability,
      sessionId,
      chatSessionId,
      workspace: getWorkspaceState(currentCwd),
      inFlight,
      historyStore,
      historyKey,
    });

    let messageChain = Promise.resolve();
    let lastReceivedAt = 0;

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
          recordStatusError: (message) =>
            historyStore.add(historyKey, {
              role: "status",
              text: message,
              ts: Date.now(),
              kind: "error",
            }),
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
      messageChain = messageChain.then(async () => {
        const result = await dispatchWsMessage({
          msg,
          ws,
          authUserId,
          sessionId,
          chatSessionId,
          userId,
          historyKey,
          currentCwd,
          cacheKey,
          sessionManager,
          orchestrator,
          getWorkspaceLock,
          interruptControllers: state.interruptControllers,
          promptRunEpochs: state.promptRunEpochs,
          historyStore,
          tasks: {
            ensureTaskContext: tasks.ensureTaskContext,
            promoteQueuedTasksToPending: tasks.promoteQueuedTasksToPending,
            broadcastToSession: tasks.broadcastToSession,
          },
          scheduler,
          commands,
          agents: {
            agentAvailability: agents.agentAvailability,
          },
          state: {
            directoryManager: state.directoryManager,
            workspaceCache: state.workspaceCache,
            cwdStore: state.cwdStore,
            cwdStorePath: state.cwdStorePath,
            persistCwdStore: state.persistCwdStore,
            broadcastSessionReset,
            resetSharedSessionState,
          },
          registerSessionCacheBinding,
          broadcastJson,
          safeJsonSend,
          sendWorkspaceState,
          traceWsDuplication: config.traceWsDuplication,
          logger,
          updateWorkspaceRootMeta: (cwd) => {
            try {
              const meta = state.clientMetaByWs.get(ws);
              if (meta) {
                meta.workspaceRoot = normalizeWorkspaceRootForMeta(cwd);
              }
            } catch {
              // ignore
            }
          },
        });
        orchestrator = result.orchestrator;
        currentCwd = result.currentCwd;
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
        promptRunEpochs: state.promptRunEpochs,
        logger,
      });
    });
  });

  return wss;
}

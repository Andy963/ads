import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { getStateDatabase } from "../../../state/database.js";
import { ensureWebAuthTables } from "../../auth/schema.js";
import { ensureWebProjectTables } from "../../projects/schema.js";
import { getWebProjectWorkspaceRoot } from "../../projects/store.js";
import { getWorkspaceState } from "../../utils.js";
import type { AttachWebSocketServerDeps, WsOrchestrator } from "./deps.js";
import { dispatchWsMessage, type IncomingWsMessage } from "./messageDispatch.js";
import { handleImmediateWsMessage, parseIncomingWsEnvelope } from "./messageIntake.js";
import { resolveWebSocketChatSessionId, resolveWebSocketSessionId } from "./session.js";
import { createSafeJsonSend, summarizeWsPayloadForLog } from "./utils.js";
import { resolveWorkspaceRootFromDirectory } from "../api/routes/workspacePath.js";
import { sendInitialBootstrapMessages } from "./bootstrapDelivery.js";
import { buildHistoryBootstrapPayload } from "./bootstrapReplay.js";
import { restoreConnectionWorkspace } from "./connectionWorkspace.js";
import { buildWsConnectionIdentity } from "./connectionIdentity.js";
import {
  abortInFlightHistory,
  broadcastJsonToHistoryKey,
  cleanupClosedConnection,
  closeConnectionsForHistoryKey,
  closeConnectionsForLogicalLane,
} from "./connectionRuntime.js";
import { resolveWsLaneResources, type WsLaneResources } from "./laneResources.js";
import { preflightPersistAndAck } from "./preflight.js";
import { resolveSharedWorkerSyncLaneKey, resolveSyncLaneKeys, resolveSyncNamespace } from "../sync/lane.js";
import { isStreamTerminalEvent, isTransientSyncEvent } from "../sync/eventClass.js";
import { createDeltaStreamCoalescer } from "../sync/deltaStream.js";
import { recordConversationMessage } from "../../../utils/conversationMessageRecorder.js";
import { WEB_WORKER_NAMESPACE } from "../start/webLaneResources.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number; sessionTokenHash?: string };

type WsLaneSnapshot = {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  userId: number;
  historyKey: string;
  logicalHistoryKey: string;
  cacheKey: string;
  laneNamespace: string;
  laneGeneration: number;
  syncLaneKeys: string[];
  currentCwd: string;
  sessionManager: WsLaneResources["sessionManager"];
  historyStore: WsLaneResources["historyStore"];
  getWorkspaceLock: WsLaneResources["getWorkspaceLock"];
  orchestrator: WsOrchestrator;
  deltaCoalescer: ReturnType<typeof createDeltaStreamCoalescer> | null;
};

/** WebSocket 单帧默认上限：16MB（足够容纳带 base64 图片的 prompt，又能挡住内存型 DoS）。 */
const DEFAULT_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function attachWebSocketServer(deps: AttachWebSocketServerDeps): WebSocketServer {
  const { auth, agents, commands, config, history, logger, scheduler, sessions, state, tasks } = deps;
  const wss = new WebSocketServer({
    server: deps.server,
    maxPayload: config.maxPayloadBytes ?? DEFAULT_WS_MAX_PAYLOAD_BYTES,
  });
  const safeJsonSend = createSafeJsonSend(logger);
  const seenChatSessionIdsBySharedSession = new Map<string, Set<string>>();
  const laneGenerationStore = state.laneGenerationStore;
  const fallbackLaneGenerations = new Map<string, number>();
  const resetClosingConnections = new WeakSet<WebSocket>();

  const getFallbackLaneGenerationKey = (namespace: string, logicalLaneKey: string): string =>
    `${String(namespace ?? "").trim()}::${String(logicalLaneKey ?? "").trim()}`;

  const getLaneGeneration = (namespace: string, logicalLaneKey: string): number => {
    if (laneGenerationStore) {
      return laneGenerationStore.getGeneration(namespace, logicalLaneKey);
    }
    const key = getFallbackLaneGenerationKey(namespace, logicalLaneKey);
    const current = fallbackLaneGenerations.get(key);
    if (current && current >= 1) {
      return current;
    }
    fallbackLaneGenerations.set(key, 1);
    return 1;
  };

  const bumpLaneGeneration = (namespace: string, logicalLaneKey: string): number => {
    if (laneGenerationStore) {
      return laneGenerationStore.bumpGeneration(namespace, logicalLaneKey);
    }
    const key = getFallbackLaneGenerationKey(namespace, logicalLaneKey);
    const next = getLaneGeneration(namespace, logicalLaneKey) + 1;
    fallbackLaneGenerations.set(key, next);
    return next;
  };

  const isLaneGenerationCurrent = (lane: Pick<WsLaneSnapshot, "laneNamespace" | "logicalHistoryKey" | "laneGeneration">): boolean =>
    getLaneGeneration(lane.laneNamespace, lane.logicalHistoryKey) === lane.laneGeneration;

  const historyKeyBelongsToLogicalLane = (historyKey: string, logicalHistoryKey: string): boolean => {
    const normalizedHistoryKey = String(historyKey ?? "").trim();
    const normalizedLogicalKey = String(logicalHistoryKey ?? "").trim();
    return Boolean(
      normalizedHistoryKey &&
        normalizedLogicalKey &&
        (normalizedHistoryKey === normalizedLogicalKey ||
          normalizedHistoryKey.startsWith(`${normalizedLogicalKey}:generation:`)),
    );
  };

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
            // 复核 session 是否仍然有效：握手时一次性鉴权，之后登出/吊销/过期的连接
            // 仍可执行命令，故每个 ping tick 重新校验，失效则关闭（4401）。
            if (auth.revalidateSession && candidate.sessionTokenHash) {
              let stillValid = true;
              try {
                stillValid = auth.revalidateSession(candidate.sessionTokenHash);
              } catch {
                stillValid = true; // 复核出错时不误杀活跃连接
              }
              if (!stillValid) {
                logger.warn("[WebSocket] terminating connection with revoked/expired session");
                try {
                  candidate.close(4401, "session expired");
                } catch {
                  // ignore
                }
                continue;
              }
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

    if (!auth.isOriginAllowed(req, auth.allowedOrigins)) {
      ws.close(4403, "forbidden");
      return;
    }

    const authResult = auth.authenticateRequest(req);
    if (!authResult.ok) {
      ws.close(4401, "unauthorized");
      return;
    }

    const sessionId = resolveWebSocketSessionId({ protocols: parsedProtocols, workspaceRoot: config.workspaceRoot });
    let chatSessionId = resolveWebSocketChatSessionId({ protocols: parsedProtocols });
    let { sessionManager, historyStore, getWorkspaceLock } = resolveWsLaneResources({
      chatSessionId,
      sessions,
      history,
    });

    const initialLogicalIdentity = buildWsConnectionIdentity({
      authUserId: authResult.userId,
      sessionId,
      chatSessionId,
    });
    let laneNamespace = resolveSyncNamespace(chatSessionId);
    let logicalHistoryKey = initialLogicalIdentity.historyKey;
    let laneGeneration = getLaneGeneration(laneNamespace, logicalHistoryKey);
    const initialIdentity = buildWsConnectionIdentity({
      authUserId: authResult.userId,
      sessionId,
      chatSessionId,
      generation: laneGeneration,
    });

    if (Number.isFinite(config.maxClients) && config.maxClients > 0 && state.clients.size >= config.maxClients) {
      ws.close(4409, `max clients reached (${config.maxClients})`);
      return;
    }
    state.clients.add(ws);
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.missedPongs = 0;
    aliveWs.sessionTokenHash = authResult.tokenHash;
    ws.on("pong", () => {
      aliveWs.isAlive = true;
      aliveWs.missedPongs = 0;
    });

    const { authUserId, connectionId } = initialIdentity;
    let {
      userId,
      historyKey,
      cacheKey,
      clientMeta,
    } = initialIdentity;
    clientMeta = { ...clientMeta, logicalHistoryKey };
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
        cwdKeys: [String(userId)],
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
      cacheKey,
      preferredProjectCwd,
      directoryManager: state.directoryManager,
      sessionManager,
      workspaceCache: state.workspaceCache,
      cwdStore: state.cwdStore,
      cwdStorePath: state.cwdStorePath,
      persistCwdStore: state.persistCwdStore,
      warn: (message) => logger.warn(message),
    });

    try {
      const meta = state.clientMetaByWs.get(ws);
      if (meta) {
        meta.workspaceRoot = normalizeWorkspaceRootForMeta(currentCwd);
      }
    } catch {
      // ignore
    }

    // Always ask to reattach. When a runtime session is already in memory
    // `getOrCreate` returns it before this flag is read; when it is not, this is
    // exactly the case a saved provider session exists for. The previous
    // `!hasSession(userId)` guard looked equivalent but was not: any earlier
    // read-only `getOrCreate` (an agents broadcast, a model override) put a
    // fresh session in memory first, after which this branch never resumed
    // again and the saved thread id was stranded for the rest of the process.
    let orchestrator = sessionManager.getOrCreate(userId, currentCwd, true);
    const contextMode = sessionManager.getContextRestoreMode(userId);

    logger.info(
      `client connected conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId} history=${historyKey} clients=${state.clients.size} restore=${contextMode}${contextMode === "history_injection" ? " (pending history injection)" : ""}${contextMode === "thread_resumed" ? " (thread resumed)" : ""}`,
    );
    const inFlight = state.interruptControllers.has(historyKey);

    let syncNamespace = laneNamespace;
    let syncLaneKeys = resolveSyncLaneKeys({
      authUserId,
      sessionId,
      chatSessionId,
      generation: laneGeneration,
    });
    const syncEventStore = state.syncEventStore;
    let deltaCoalescer = syncEventStore
      ? createDeltaStreamCoalescer({
          store: syncEventStore,
          namespace: syncNamespace,
        laneKey: historyKey,
      })
      : null;
    const appendSyncEventForLane = (
      lane: WsLaneSnapshot,
      payload: unknown,
      onFailure?: () => void,
    ): { ok: boolean; payload: unknown } => {
      if (!isLaneGenerationCurrent(lane)) {
        return { ok: false, payload };
      }
      const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
      const eventType = String(payloadRecord?.type ?? "").trim();
      if (!payloadRecord || !eventType || !syncEventStore) {
        return { ok: true, payload };
      }
      if (isTransientSyncEvent(eventType)) {
        // Live-only frames are broadcast without entering the replay log. Main
        // assistant deltas are folded into one coalesced `delta_snapshot`.
        if (eventType === "delta" && lane.deltaCoalescer && !String(payloadRecord.source ?? "").trim()) {
          lane.deltaCoalescer.appendDelta(String(payloadRecord.delta ?? ""));
        }
        return { ok: true, payload };
      }
      if (lane.deltaCoalescer && isStreamTerminalEvent(eventType)) {
        lane.deltaCoalescer.finish();
      }
      const seq = syncEventStore.append({
        namespace: lane.laneNamespace,
        laneKey: lane.historyKey,
        type: eventType,
        payload: payloadRecord,
      });
      if (seq === null) {
        logger.warn(`[WebSocket][Sync] refusing unlogged event type=${eventType} history=${lane.historyKey}`);
        (onFailure ?? (() => {
          closeConnectionsForHistoryKey({
            clientMetaByWs: state.clientMetaByWs,
            historyKey: lane.historyKey,
            code: 1011,
            reason: "sync persistence failed",
          });
        }))();
        return { ok: false, payload };
      }
      return { ok: true, payload: { ...payloadRecord, seq } };
    };
    const broadcastJsonForLane = (lane: WsLaneSnapshot, payload: unknown): void => {
      if (!isLaneGenerationCurrent(lane)) return;
      const appended = appendSyncEventForLane(lane, payload);
      if (!appended.ok) return;
      broadcastJsonToHistoryKey({
        clientMetaByWs: state.clientMetaByWs,
        historyKey: lane.historyKey,
        logicalHistoryKey: lane.logicalHistoryKey,
        laneGeneration: lane.laneGeneration,
        payload: appended.payload,
        sendJson: safeJsonSend,
      });
    };
    const broadcastHistoryToSiblingConnectionsForLane = (lane: WsLaneSnapshot): void => {
      const payload = buildHistoryBootstrapPayload(lane.historyStore.get(lane.historyKey));
      if (!payload) {
        return;
      }
      const appended = appendSyncEventForLane(lane, payload);
      if (!appended.ok) return;
      broadcastJsonToHistoryKey({
        clientMetaByWs: state.clientMetaByWs,
        historyKey: lane.historyKey,
        logicalHistoryKey: lane.logicalHistoryKey,
        laneGeneration: lane.laneGeneration,
        payload: appended.payload,
        sendJson: safeJsonSend,
        excludeWs: ws,
      });
    };
    const broadcastInFlightToSiblingConnectionsForLane = (lane: WsLaneSnapshot): void => {
      const appended = appendSyncEventForLane(lane, { type: "in_flight", inFlight: true });
      if (!appended.ok) return;
      broadcastJsonToHistoryKey({
        clientMetaByWs: state.clientMetaByWs,
        historyKey: lane.historyKey,
        logicalHistoryKey: lane.logicalHistoryKey,
        laneGeneration: lane.laneGeneration,
        payload: appended.payload,
        sendJson: safeJsonSend,
        excludeWs: ws,
      });
    };
    const broadcastWorkspaceStateForLane = (lane: WsLaneSnapshot, workspaceRoot: string): void => {
      try {
        broadcastJsonForLane(lane, { type: "workspace", data: getWorkspaceState(workspaceRoot) });
      } catch {
        // ignore
      }
    };

    const broadcastSessionResetForLane = (_lane: WsLaneSnapshot, payload: unknown): void => {
      const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
      const resetScope = String(payloadRecord.scope ?? "").trim().toLowerCase();
      const sourceChatSessionId = String(payloadRecord.sourceChatSessionId ?? "").trim();
      // A reset is a control signal, not chat history. It has no sequence
      // number and must never enter a lane replay log, otherwise another lane
      // can consume a sequence that belongs to the source lane.
      for (const [candidate, meta] of state.clientMetaByWs.entries()) {
        if (meta.authUserId !== authUserId || meta.sessionId !== sessionId) {
          continue;
        }
        if (resetScope === "shared" && meta.chatSessionId === "planner") {
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
      const tracked = new Set<string>(["main"]);
      for (const seenChatSessionId of seenChatSessionIdsBySharedSession.get(registryKey) ?? []) {
        if (seenChatSessionId !== "planner") {
          tracked.add(seenChatSessionId);
        }
      }
      for (const meta of state.clientMetaByWs.values()) {
        if (meta.authUserId !== authUserId || meta.sessionId !== sessionId) {
          continue;
        }
        const candidateChatSessionId = String(meta.chatSessionId ?? "").trim();
        if (candidateChatSessionId && candidateChatSessionId !== "planner") {
          tracked.add(candidateChatSessionId);
        }
      }
      return [...tracked];
    };

    const captureLane = (): WsLaneSnapshot => ({
      authUserId,
      sessionId,
      chatSessionId,
      userId,
      historyKey,
      logicalHistoryKey,
      cacheKey,
      laneNamespace: syncNamespace,
      laneGeneration,
      syncLaneKeys: [...syncLaneKeys],
      currentCwd,
      sessionManager,
      historyStore,
      getWorkspaceLock,
      orchestrator,
      deltaCoalescer,
    });

    let currentLane = captureLane();

    const isCurrentLane = (lane: WsLaneSnapshot): boolean =>
      currentLane.historyKey === lane.historyKey &&
      currentLane.laneNamespace === lane.laneNamespace &&
      currentLane.laneGeneration === lane.laneGeneration;

    const isLaneCurrent = (lane: WsLaneSnapshot): boolean =>
      isCurrentLane(lane) && isLaneGenerationCurrent(lane);

    const abortInFlightForHistoryKey = (targetHistoryKey: string): boolean =>
      abortInFlightHistory({
        interruptControllers: state.interruptControllers,
        promptRunEpochs: state.promptRunEpochs,
        historyKey: targetHistoryKey,
      });

    type ResetCloseTarget = Pick<WsLaneSnapshot, "authUserId" | "sessionId" | "chatSessionId" | "logicalHistoryKey">;
    let resetCloseTargets: ResetCloseTarget[] = [];

    const collectKnownLaneState = (lane: {
      authUserId: string;
      sessionId: string;
      chatSessionId: string;
      logicalHistoryKey: string;
      laneNamespace: string;
      historyStore: WsLaneSnapshot["historyStore"];
      sessionManager: WsLaneSnapshot["sessionManager"];
    }, currentGeneration: number): { historyKeys: string[]; userIds: number[] } => {
      const normalizedGeneration = Math.max(1, Math.floor(currentGeneration || 1));
      const historyKeys = new Set<string>();
      const userIds = new Set<number>();
      for (let generation = 1; generation <= normalizedGeneration; generation += 1) {
        const identity = buildWsConnectionIdentity({
          authUserId: lane.authUserId,
          sessionId: lane.sessionId,
          chatSessionId: lane.chatSessionId,
          generation,
          randomHex: () => "",
        });
        historyKeys.add(identity.historyKey);
        userIds.add(identity.userId);
      }
      for (const [candidate, meta] of state.clientMetaByWs.entries()) {
        void candidate;
        if (
          meta.authUserId !== lane.authUserId ||
          meta.sessionId !== lane.sessionId ||
          meta.chatSessionId !== lane.chatSessionId ||
          !historyKeyBelongsToLogicalLane(meta.historyKey, lane.logicalHistoryKey)
        ) {
          continue;
        }
        historyKeys.add(meta.historyKey);
        userIds.add(meta.sessionUserId);
      }
      for (const historyKey of state.interruptControllers.keys()) {
        if (historyKeyBelongsToLogicalLane(historyKey, lane.logicalHistoryKey)) {
          historyKeys.add(historyKey);
        }
      }
      for (const historyKey of state.promptRunEpochs?.keys() ?? []) {
        if (historyKeyBelongsToLogicalLane(historyKey, lane.logicalHistoryKey)) {
          historyKeys.add(historyKey);
        }
      }
      return { historyKeys: [...historyKeys], userIds: [...userIds] };
    };

    const resetOneLogicalLane = (lane: {
      authUserId: string;
      sessionId: string;
      chatSessionId: string;
      logicalHistoryKey: string;
      laneNamespace: string;
      historyStore: WsLaneSnapshot["historyStore"];
      sessionManager: WsLaneSnapshot["sessionManager"];
    }): number => {
      const currentGeneration = getLaneGeneration(lane.laneNamespace, lane.logicalHistoryKey);
      const known = collectKnownLaneState(lane, currentGeneration);
      const nextGeneration = bumpLaneGeneration(lane.laneNamespace, lane.logicalHistoryKey);
      for (const historyKey of known.historyKeys) {
        abortInFlightForHistoryKey(historyKey);
        lane.historyStore.clear(historyKey);
      }
      for (const userId of known.userIds) {
        lane.sessionManager.reset(userId);
      }
      state.syncEventStore?.clearLanes({
        namespace: lane.laneNamespace,
        laneKeys: known.historyKeys,
      });
      resetCloseTargets.push({
        authUserId: lane.authUserId,
        sessionId: lane.sessionId,
        chatSessionId: lane.chatSessionId,
        logicalHistoryKey: lane.logicalHistoryKey,
      });
      return nextGeneration;
    };

    const resetLaneStateForLane = (lane: WsLaneSnapshot): number | undefined => {
      resetCloseTargets = [];
      return resetOneLogicalLane(lane);
    };

    const resetSharedSessionStateForLane = (_lane: WsLaneSnapshot, options: {
      sourceChatSessionId: string;
    }): { sourceGeneration?: number; laneGenerations: Record<string, number> } | undefined => {
      resetCloseTargets = [];
      const laneGenerations: Record<string, number> = {};
      for (const trackedChatSessionId of getTrackedSharedChatSessionIds()) {
        const { sessionManager: trackedSessionManager, historyStore: trackedHistoryStore } = resolveWsLaneResources({
          chatSessionId: trackedChatSessionId,
          sessions,
          history,
        });
        const logicalIdentity = buildWsConnectionIdentity({
          authUserId,
          sessionId,
          chatSessionId: trackedChatSessionId,
          randomHex: () => "",
        });
        const nextGeneration = resetOneLogicalLane({
          authUserId,
          sessionId,
          chatSessionId: trackedChatSessionId,
          logicalHistoryKey: logicalIdentity.historyKey,
          laneNamespace: resolveSyncNamespace(trackedChatSessionId),
          historyStore: trackedHistoryStore,
          sessionManager: trackedSessionManager,
        });
        laneGenerations[trackedChatSessionId] = nextGeneration;
      }
      const sourceGeneration = laneGenerations[options.sourceChatSessionId];
      return { sourceGeneration, laneGenerations };
    };

    const closeAfterReset = (): void => {
      const targets = [...resetCloseTargets];
      resetCloseTargets = [];
      for (const target of targets) {
        for (const [candidate, meta] of state.clientMetaByWs.entries()) {
          if (
            meta.authUserId === target.authUserId &&
            meta.sessionId === target.sessionId &&
            meta.chatSessionId === target.chatSessionId &&
            historyKeyBelongsToLogicalLane(meta.historyKey, target.logicalHistoryKey)
          ) {
            resetClosingConnections.add(candidate);
          }
        }
        closeConnectionsForLogicalLane({
          clientMetaByWs: state.clientMetaByWs,
          logicalHistoryKey: target.logicalHistoryKey,
          authUserId: target.authUserId,
          sessionId: target.sessionId,
          chatSessionId: target.chatSessionId,
          code: 1012,
          reason: "session reset",
        });
      }
    };

    sendInitialBootstrapMessages({
      ws,
      safeJsonSend,
      sessionManager: currentLane.sessionManager,
      orchestrator: currentLane.orchestrator,
      userId: currentLane.userId,
      agentAvailability: agents.agentAvailability,
      sessionId,
      chatSessionId: currentLane.chatSessionId,
      workspace: getWorkspaceState(currentCwd),
      inFlight,
      historyStore: currentLane.historyStore,
      historyKey: currentLane.historyKey,
      latestSeq: state.syncEventStore?.getLatestSeqForLanes(currentLane.laneNamespace, currentLane.syncLaneKeys) ?? 0,
      taskLatestSeq:
        currentLane.chatSessionId === "planner"
          ? 0
          : state.syncEventStore?.getLatestSeq(WEB_WORKER_NAMESPACE, resolveSharedWorkerSyncLaneKey(sessionId)) ?? 0,
      laneGeneration: currentLane.laneGeneration,
    });

    let messageChain = Promise.resolve();
    let pendingSwitchCount = 0;
    let lastReceivedAt = 0;

    const handleImmediateForLane = (lane: WsLaneSnapshot, parsed: IncomingWsMessage["parsed"], receivedAt: number): boolean =>
      handleImmediateWsMessage({
        parsed,
        receivedAt,
        abortInFlight: () => abortInFlightForHistoryKey(lane.historyKey),
        isLaneCurrent: () => isLaneCurrent(lane),
        sendJson: (payload) => safeJsonSend(ws, payload),
        broadcastJson: (payload) => broadcastJsonForLane(lane, payload),
        recordStatusError: (message) =>
          lane.historyStore.add(lane.historyKey, {
            role: "status",
            text: message,
            ts: Date.now(),
            kind: "error",
          }),
      });

    const runPreflightForLane = (
      lane: WsLaneSnapshot,
      parsed: IncomingWsMessage["parsed"],
      requestId: string,
      clientMessageId: string | null,
      receivedAt: number,
    ): ReturnType<typeof preflightPersistAndAck> =>
      preflightPersistAndAck({
        parsed,
        requestId,
        clientMessageId,
        receivedAt,
        historyStore: lane.historyStore,
        historyKey: lane.historyKey,
        sanitizeInput: commands.sanitizeInput,
        sendJson: (payload) => safeJsonSend(ws, payload),
        broadcastPersistedHistory: () => broadcastHistoryToSiblingConnectionsForLane(lane),
        broadcastInFlight: () => broadcastInFlightToSiblingConnectionsForLane(lane),
        inFlight: state.interruptControllers.has(lane.historyKey),
        isLaneCurrent: () => isLaneCurrent(lane),
        traceWsDuplication: config.traceWsDuplication,
        warn: (message) => logger.warn(message),
        sessionId: lane.sessionId,
        userId: lane.userId,
        onPersistedMessage: ({ clientMessageId: persistedId, text }) => {
          recordConversationMessage({
            eventId: persistedId,
            workspaceRoot: normalizeWorkspaceRootForMeta(lane.currentCwd),
            sessionId: lane.sessionId,
            source: "web",
            role: "user",
            text,
            agentId: lane.orchestrator.getActiveAgentId?.(),
          });
        },
      });

    ws.on("message", (data: RawData) => {
      const envelope = parseIncomingWsEnvelope({ data, lastReceivedAt });
      lastReceivedAt = envelope.nextReceivedAt;
      if (!envelope.ok) {
        safeJsonSend(ws, { type: "error", message: envelope.errorMessage });
        return;
      }

      const { parsed, receivedAt } = envelope;
      if (resetClosingConnections.has(ws)) {
        return;
      }
      const clientMessageId =
        envelope.clientMessageId ??
        (parsed.type === "prompt" || parsed.type === "command"
          ? `server-${crypto.randomUUID()}`
          : null);

      if (parsed.type === "interrupt" && pendingSwitchCount > 0) {
        messageChain = messageChain
          .then(() => {
            if (resetClosingConnections.has(ws)) return;
            handleImmediateForLane(currentLane, parsed, receivedAt);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[WebSocket] deferred interrupt failed conn=${connectionId} user=${currentLane.userId}: ${message}`);
          });
        return;
      }

      const laneAtReceipt = pendingSwitchCount === 0 ? currentLane : null;
      if (handleImmediateForLane(laneAtReceipt ?? currentLane, parsed, receivedAt)) {
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

      if (parsed.type === "switch_chat_session") {
        pendingSwitchCount += 1;
        messageChain = messageChain
          .then(async () => {
            const previousLane = currentLane;
            const payload = parsed.payload;
            const targetChatSessionId =
              typeof payload === "object" && payload !== null && "chatSessionId" in payload
                ? String((payload as { chatSessionId?: unknown }).chatSessionId ?? "").trim()
                : "";
            const nextChatSessionId = targetChatSessionId || crypto.randomUUID();

            abortInFlightForHistoryKey(previousLane.historyKey);

            const nextLaneRes = resolveWsLaneResources({ chatSessionId: nextChatSessionId, sessions, history });
            const nextLogicalIdentity = buildWsConnectionIdentity({
              authUserId,
              sessionId,
              chatSessionId: nextChatSessionId,
              randomHex: () => "",
            });
            const nextLaneNamespace = resolveSyncNamespace(nextChatSessionId);
            const nextLaneGeneration = getLaneGeneration(nextLaneNamespace, nextLogicalIdentity.historyKey);
            const nextIdentity = buildWsConnectionIdentity({
              authUserId,
              sessionId,
              chatSessionId: nextChatSessionId,
              connectionId,
              generation: nextLaneGeneration,
            });

            chatSessionId = nextChatSessionId;
            sessionManager = nextLaneRes.sessionManager;
            historyStore = nextLaneRes.historyStore;
            getWorkspaceLock = nextLaneRes.getWorkspaceLock;
            const workspaceRoot = state.clientMetaByWs.get(ws)?.workspaceRoot;
            userId = nextIdentity.userId;
            historyKey = nextIdentity.historyKey;
            cacheKey = nextIdentity.cacheKey;
            logicalHistoryKey = nextLogicalIdentity.historyKey;
            laneNamespace = nextLaneNamespace;
            laneGeneration = nextLaneGeneration;
            clientMeta = workspaceRoot
              ? { ...nextIdentity.clientMeta, workspaceRoot }
              : nextIdentity.clientMeta;
            state.clientMetaByWs.set(ws, clientMeta);
            registerSeenChatSessionId(authUserId, sessionId, chatSessionId);

            registerSessionCacheBinding();
            orchestrator = sessionManager.getOrCreate(userId, currentCwd, true);

            const nextSyncLaneKeys = resolveSyncLaneKeys({
              authUserId,
              sessionId,
              chatSessionId,
              generation: laneGeneration,
            });
            deltaCoalescer?.finish();
            syncNamespace = nextLaneNamespace;
            syncLaneKeys = nextSyncLaneKeys;
            deltaCoalescer = syncEventStore
              ? createDeltaStreamCoalescer({
                  store: syncEventStore,
                  namespace: syncNamespace,
                  laneKey: historyKey,
                })
              : null;
            currentLane = captureLane();

            sendInitialBootstrapMessages({
              ws,
              safeJsonSend,
              sessionManager: currentLane.sessionManager,
              orchestrator: currentLane.orchestrator,
              userId: currentLane.userId,
              agentAvailability: agents.agentAvailability,
              sessionId,
              chatSessionId: currentLane.chatSessionId,
              workspace: getWorkspaceState(currentLane.currentCwd),
              inFlight: false,
              historyStore: currentLane.historyStore,
              historyKey: currentLane.historyKey,
              latestSeq: state.syncEventStore?.getLatestSeqForLanes(currentLane.laneNamespace, currentLane.syncLaneKeys) ?? 0,
              taskLatestSeq:
                currentLane.chatSessionId === "planner"
                  ? 0
                  : state.syncEventStore?.getLatestSeq(WEB_WORKER_NAMESPACE, resolveSharedWorkerSyncLaneKey(sessionId)) ?? 0,
              laneGeneration: currentLane.laneGeneration,
            });

            logger.info(
              "[WebSocket] in-band session switch conn=" + connectionId + " session=" + sessionId + " chat=" + chatSessionId + " user=" + userId + " history=" + historyKey,
            );
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("[WebSocket] switch_chat_session failed conn=" + connectionId + " user=" + currentLane.userId + ": " + message);
            safeJsonSend(ws, { type: "error", message: "Failed to switch chat session" });
          })
          .finally(() => {
            pendingSwitchCount = Math.max(0, pendingSwitchCount - 1);
          });
        return;
      }

      const runPreflight = (lane: WsLaneSnapshot): ReturnType<typeof preflightPersistAndAck> =>
        runPreflightForLane(lane, parsed, requestId, clientMessageId, receivedAt);
      const preflight = laneAtReceipt ? runPreflight(laneAtReceipt) : null;
      if (preflight && !preflight.enqueue) {
        return;
      }

      const msg: IncomingWsMessage = { parsed, requestId, clientMessageId, receivedAt };
      messageChain = messageChain
        .then(async () => {
          if (resetClosingConnections.has(ws)) return;
          const lane = laneAtReceipt
            ? currentLane.historyKey === laneAtReceipt.historyKey
              ? currentLane
              : laneAtReceipt
            : currentLane;
          const queuedPreflight = preflight ?? runPreflight(lane);
          if (!queuedPreflight.enqueue) {
            return;
          }

          const result = await dispatchWsMessage({
            msg,
            ws,
            authUserId: lane.authUserId,
            sessionId: lane.sessionId,
            chatSessionId: lane.chatSessionId,
            userId: lane.userId,
            historyKey: lane.historyKey,
            currentCwd: lane.currentCwd,
            cacheKey: lane.cacheKey,
            sessionManager: lane.sessionManager,
            orchestrator: lane.orchestrator,
            getWorkspaceLock: lane.getWorkspaceLock,
            interruptControllers: state.interruptControllers,
            promptRunEpochs: state.promptRunEpochs,
            historyStore: lane.historyStore,
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
              broadcastSessionReset: (payload) => broadcastSessionResetForLane(lane, payload),
              resetLaneState: () => resetLaneStateForLane(lane),
              resetSharedSessionState: (options) => resetSharedSessionStateForLane(lane, options),
              closeAfterReset,
            },
            registerSessionCacheBinding: () =>
              state.sessionCacheRegistry.registerBinding({
                userId: lane.userId,
                cacheKey: lane.cacheKey,
                cwdKeys: [String(lane.userId)],
              }),
            broadcastJson: (payload) => broadcastJsonForLane(lane, payload),
            safeJsonSend,
            sendWorkspaceState,
            broadcastWorkspaceState: (workspaceRoot) => broadcastWorkspaceStateForLane(lane, workspaceRoot),
            traceWsDuplication: config.traceWsDuplication,
            logger,
            updateWorkspaceRootMeta: (cwd) => {
              if (!isCurrentLane(lane)) return;
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
          if (isCurrentLane(lane)) {
            orchestrator = result.orchestrator;
            currentCwd = result.currentCwd;
            currentLane = { ...currentLane, orchestrator, currentCwd };
          }
        })
        .catch((error) => {
          // A single message handler failing must not poison the chain and freeze
          // all subsequent messages on this connection.
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`[WebSocket] message handler failed conn=${connectionId} user=${userId}: ${message}`);
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

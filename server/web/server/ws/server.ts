import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";

import { getStateDatabase } from "../../../state/database.js";
import { RuntimeBackendMismatchError } from "../../../sessions/sessionState.js";
import { ensureWebAuthTables } from "../../auth/schema.js";
import { ensureWebProjectTables } from "../../projects/schema.js";
import { getWebProjectWorkspaceRoot } from "../../projects/store.js";
import { getWorkspaceState } from "../../utils.js";
import type { AttachWebSocketServerDeps, WsOrchestrator } from "./deps.js";
import { dispatchWsMessage, type IncomingWsMessage } from "./messageDispatch.js";
import { handleImmediateWsMessage, parseIncomingWsEnvelope } from "./messageIntake.js";
import { normalizeLaneChatSessionId, resolveWebSocketChatSessionId, resolveWebSocketSessionId } from "./session.js";
import { createSafeJsonSend, summarizeWsPayloadForLog } from "./utils.js";
import { resolveWorkspaceRootFromDirectory } from "../api/routes/workspacePath.js";
import { sendInitialBootstrapMessages } from "./bootstrapDelivery.js";
import { parseTranscriptResume } from "./transcriptResume.js";
import { buildHistoryBootstrapPayload } from "./bootstrapReplay.js";
import { restoreConnectionWorkspace } from "./connectionWorkspace.js";
import { buildWsConnectionIdentity } from "./connectionIdentity.js";
import {
  abortInFlightHistory,
  broadcastJsonToHistoryKey,
  cleanupClosedConnection,
  closeConnectionsForHistoryKey,
} from "./connectionRuntime.js";
import { resolveWsLaneResources, type WsLaneResources } from "./laneResources.js";
import { preflightPersistAndAck } from "./preflight.js";
import { resolveSyncLaneKeys, resolveSyncNamespace } from "../sync/lane.js";
import { isStreamTerminalEvent, isTransientSyncEvent } from "../sync/eventClass.js";
import { createDeltaStreamCoalescer } from "../sync/deltaStream.js";
import { createCommandSnapshotCoalescer } from "../sync/commandSnapshot.js";
import { projectCommandFrame } from "../commandPresentation.js";
import { recordConversationMessage } from "../../../utils/conversationMessageRecorder.js";
import { WEB_WORKER_NAMESPACE } from "../start/webLaneResources.js";
import { onTaskTerminalEvent } from "../../taskNotifications/taskNotificationDispatcher.js";

import { handlePromptMessage } from "./handlePrompt.js";
import { ensureWsSessionLogger } from "./messageControl.js";
import type { WsMessage } from "./schema.js";
import { PromptQueueService } from "../promptQueueService.js";
import { getPromptQueueHistoryOutcome } from "../promptQueueHistory.js";
import type { PromptQueueEntry } from "../../../state/promptQueueStore.js";

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number; sessionTokenHash?: string; isConnector?: boolean };

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
  commandSnapshotCoalescer: ReturnType<typeof createCommandSnapshotCoalescer> | null;
  bindingVersion: number;
};

type WsResetTarget = {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  logicalHistoryKey: string;
  laneGeneration: number;
};

type WsInBandResetHandler = (target: WsResetTarget) => void;
type ResetBarrierScope = "lane" | "shared";

type ResetBarrier = {
  count: number;
  promise: Promise<void>;
  resolve: () => void;
};

type ResetBarrierToken = {
  key: string;
  barrier: ResetBarrier;
  released: boolean;
};

/** WebSocket 单帧默认上限：16MB（足够容纳带 base64 图片的 prompt，又能挡住内存型 DoS）。 */
const DEFAULT_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function attachWebSocketServer(deps: AttachWebSocketServerDeps): WebSocketServer {
  const { auth, agents, commands, config, history, logger, scheduler, sessions, state } = deps;
  const wss = new WebSocketServer({
    server: deps.server,
    maxPayload: config.maxPayloadBytes ?? DEFAULT_WS_MAX_PAYLOAD_BYTES,
  });
  const safeJsonSend = createSafeJsonSend(logger);
  const removeTaskTerminalListener = onTaskTerminalEvent((event) => {
    const eventWorkspace = String(event.workspaceRoot ?? "").trim();
    if (!eventWorkspace) return;
    for (const [candidate, meta] of state.clientMetaByWs.entries()) {
      if (meta.workspaceRoot && meta.workspaceRoot !== eventWorkspace) continue;
      if (candidate.readyState === 1) {
        safeJsonSend(candidate, { type: "task_terminal", event });
      }
    }
  });
  const seenChatSessionIdsBySharedSession = new Map<string, Set<string>>();
  const laneGenerationStore = state.laneGenerationStore;
  const fallbackLaneGenerations = new Map<string, number>();
  const inBandResetHandlers = new Map<WebSocket, WsInBandResetHandler>();
  const resetBarriers = new Map<string, ResetBarrier>();
  const laneSyncRuntimes = new Map<
    string,
    {
      deltaCoalescer: ReturnType<typeof createDeltaStreamCoalescer>;
      commandSnapshotCoalescer: ReturnType<typeof createCommandSnapshotCoalescer>;
    }
  >();

  const syncRuntimeKey = (namespace: string, laneKey: string): string => `${namespace}\u0000${laneKey}`;

  const resetBarrierKey = (
    authUserId: string,
    sessionId: string,
    scope: ResetBarrierScope,
    chatSessionId?: string,
  ): string =>
    scope === "shared"
      ? `${String(authUserId ?? "").trim()}\u0000${String(sessionId ?? "").trim()}\u0000shared`
      : `${String(authUserId ?? "").trim()}\u0000${String(sessionId ?? "").trim()}\u0000lane\u0000${String(chatSessionId ?? "").trim()}`;

  const resolveResetBarrierScope = (chatSessionId: string, payload: unknown): ResetBarrierScope => {
    if (String(chatSessionId ?? "").trim() === "advisor") {
      return "lane";
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const scope = String((payload as Record<string, unknown>).scope ?? "").trim().toLowerCase();
      if (scope === "shared" || scope === "project") {
        return "shared";
      }
    }
    return "lane";
  };

  const beginResetBarrier = (args: {
    authUserId: string;
    sessionId: string;
    chatSessionId: string;
    payload: unknown;
  }): ResetBarrierToken => {
    const scope = resolveResetBarrierScope(args.chatSessionId, args.payload);
    const key = resetBarrierKey(args.authUserId, args.sessionId, scope, args.chatSessionId);
    const existing = resetBarriers.get(key);
    if (existing) {
      existing.count += 1;
      return { key, barrier: existing, released: false };
    }
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const barrier = { count: 1, promise, resolve };
    resetBarriers.set(key, barrier);
    return { key, barrier, released: false };
  };

  const releaseResetBarrier = (token: ResetBarrierToken | null): void => {
    if (!token || token.released) return;
    token.released = true;
    const barrier = token.barrier;
    barrier.count -= 1;
    if (barrier.count > 0) return;
    if (resetBarriers.get(token.key) === barrier) {
      resetBarriers.delete(token.key);
    }
    barrier.resolve();
  };

  const waitForResetBarriers = (args: {
    authUserId: string;
    sessionId: string;
    chatSessionId: string;
  }): Promise<void> => {
    const waits = [
      resetBarriers.get(resetBarrierKey(args.authUserId, args.sessionId, "shared"))?.promise,
      resetBarriers.get(resetBarrierKey(args.authUserId, args.sessionId, "lane", args.chatSessionId))?.promise,
    ].filter((promise): promise is Promise<void> => Boolean(promise));
    return waits.length > 0 ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  };

  const getLaneSyncRuntime = (namespace: string, laneKey: string, _inFlight: boolean) => {
    const key = syncRuntimeKey(namespace, laneKey);
    const existing = laneSyncRuntimes.get(key);
    if (existing) return existing;
    const syncEventStore = state.syncEventStore;
    if (!syncEventStore) return null;
    // Runtime rows are the source of truth for a reconnect. Do not clear them
    // merely because the connection was opened before the in-flight map was
    // observed; that ordering used to erase the command a reconnect needed.
    const runtime = {
      deltaCoalescer: createDeltaStreamCoalescer({
        store: syncEventStore,
        namespace,
        laneKey,
        hydrate: true,
      }),
      commandSnapshotCoalescer: createCommandSnapshotCoalescer({
        store: syncEventStore,
        namespace,
        laneKey,
        hydrate: true,
      }),
    };
    laneSyncRuntimes.set(key, runtime);
    return runtime;
  };

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

  const publicPromptQueueEntry = (entry: PromptQueueEntry): Record<string, unknown> => ({
    clientMessageId: entry.clientMessageId,
    status: entry.status,
    position: entry.position,
    attempts: entry.attempts,
    lastError: entry.lastError,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  });

  const promptQueueEventRevision = (entry: PromptQueueEntry): number => {
    const statusRevision: Record<PromptQueueEntry["status"], number> = {
      queued: 1,
      running: 2,
      completed: 3,
      failed: 4,
    };
    return (Math.max(0, entry.attempts) + 1) * 10 + statusRevision[entry.status];
  };

  const emitPromptQueuePayload = (entry: PromptQueueEntry, payload: unknown): void => {
    let framed = projectCommandFrame(payload);
    const record = framed && typeof framed === "object" && !Array.isArray(framed)
      ? framed as Record<string, unknown>
      : null;
    const type = String(record?.type ?? "").trim();
    if (state.syncEventStore && record && type && !isTransientSyncEvent(type)) {
      if (type === "prompt_queue") {
        const seq = state.syncEventStore.appendCoalesced({
          namespace: entry.laneNamespace,
          laneKey: entry.historyKey,
          type,
          eventId: `prompt_queue:${entry.clientMessageId}`,
          revision: promptQueueEventRevision(entry),
          payload: record,
          ts: Date.now(),
        });
        if (seq !== null) {
          framed = { ...record, seq };
        }
      } else {
        const explicitEventId = String(record.eventId ?? record.event_id ?? "").trim();
        state.syncEventStore.append({
          namespace: entry.laneNamespace,
          laneKey: entry.historyKey,
          type,
          payload: record,
          eventId: explicitEventId || undefined,
          ts: Date.now(),
        });
      }
    }
    broadcastJsonToHistoryKey({
      clientMetaByWs: state.clientMetaByWs,
      historyKey: entry.historyKey,
      logicalHistoryKey: entry.logicalHistoryKey,
      laneGeneration: entry.laneGeneration,
      payload: framed,
      sendJson: safeJsonSend,
    });
  };

  const queueTransportWs = { readyState: 1 } as unknown as WebSocket;
  const runQueuedPrompt = async (entry: PromptQueueEntry): Promise<{ ok: boolean; error?: string }> => {
    const laneResources = resolveWsLaneResources({ chatSessionId: entry.chatSessionId, sessions, history });
    const orchestrator = laneResources.sessionManager.getOrCreate(entry.userId, entry.workspaceRoot, true, {
      authUserId: entry.authUserId,
    });
    const isCurrent = (): boolean =>
      getLaneGeneration(entry.laneNamespace, entry.logicalHistoryKey) === entry.laneGeneration;
    const parsedPrompt = { type: "prompt", payload: entry.payload } as WsMessage;
    preflightPersistAndAck({
      parsed: parsedPrompt,
      requestId: `prompt-queue-${entry.id}`,
      clientMessageId: entry.clientMessageId,
      receivedAt: entry.createdAt,
      historyStore: laneResources.historyStore,
      historyKey: entry.historyKey,
      sanitizeInput: (payload) => {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const text = (payload as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
        return commands.sanitizeInput(payload);
      },
      sendJson: () => undefined,
      inFlight: state.interruptControllers.has(entry.historyKey),
      isLaneCurrent: isCurrent,
      traceWsDuplication: false,
      warn: (message) => logger.warn(message),
      sessionId: entry.sessionId,
      userId: entry.userId,
      emitUserSyncEvent: (event) => {
        emitPromptQueuePayload(entry, event);
        return { ok: true };
      },
      onPersistedMessage: ({ clientMessageId, text }) => {
        recordConversationMessage({
          eventId: clientMessageId,
          workspaceRoot: entry.workspaceRoot,
          sessionId: entry.sessionId,
          source: "web",
          role: "user",
          text,
        });
      },
    });
    const historyOutcome = getPromptQueueHistoryOutcome(
      laneResources.historyStore.get(entry.historyKey),
      entry.clientMessageId,
      entry.payload.replay_incomplete === true,
    );
    if (historyOutcome === "missing") {
      return { ok: false, error: "Queued prompt history could not be persisted" };
    }
    if (historyOutcome === "completed") {
      return { ok: true };
    }
    const result = await handlePromptMessage({
      request: {
        parsed: parsedPrompt,
        requestId: `prompt-queue-${entry.id}`,
        clientMessageId: entry.clientMessageId,
        receivedAt: entry.createdAt,
      },
      transport: {
        ws: queueTransportWs,
        safeJsonSend: () => undefined,
        broadcastJson: (payload) => emitPromptQueuePayload(entry, payload),
        sendWorkspaceState: () => undefined,
        broadcastWorkspaceState: () => undefined,
      },
      observability: {
        logger,
        sessionLogger: ensureWsSessionLogger({
          sessionManager: laneResources.sessionManager,
          userId: entry.userId,
          warn: logger.warn,
        }),
        traceWsDuplication: false,
      },
      context: {
        authUserId: entry.authUserId,
        sessionId: entry.sessionId,
        chatSessionId: entry.chatSessionId,
        userId: entry.userId,
        historyKey: entry.historyKey,
        currentCwd: entry.workspaceRoot,
        isLaneCurrent: isCurrent,
      },
      sessions: {
        sessionManager: laneResources.sessionManager,
        orchestrator,
        getWorkspaceLock: laneResources.getWorkspaceLock,
        interruptControllers: state.interruptControllers,
        promptRunEpochs: state.promptRunEpochs,
      },
      history: { historyStore: laneResources.historyStore },
      scheduler,
    });
    return result.outcome;
  };

  const promptQueueService = state.promptQueueStore
    ? new PromptQueueService({
        store: state.promptQueueStore,
        workerId: `web-${process.pid}-${crypto.randomUUID()}`,
        resolveCurrentGeneration: (entry) => getLaneGeneration(entry.laneNamespace, entry.logicalHistoryKey),
        reconcileBeforeRun: async (entry) => {
          const laneResources = resolveWsLaneResources({ chatSessionId: entry.chatSessionId, sessions, history });
          const outcome = getPromptQueueHistoryOutcome(
            laneResources.historyStore.get(entry.historyKey),
            entry.clientMessageId,
            entry.payload.replay_incomplete === true,
          );
          return outcome === "completed" ? { ok: true } : null;
        },
        runPrompt: runQueuedPrompt,
        emitSnapshot: (entry) => {
          const snapshot = state.promptQueueStore?.listLane({
            authUserId: entry.authUserId,
            sessionId: entry.sessionId,
            chatSessionId: entry.chatSessionId,
            historyKey: entry.historyKey,
            logicalHistoryKey: entry.logicalHistoryKey,
            laneNamespace: entry.laneNamespace,
            laneGeneration: entry.laneGeneration,
          }) ?? [entry];
          const current = snapshot.find((candidate) => candidate.clientMessageId === entry.clientMessageId) ?? entry;
          emitPromptQueuePayload(entry, {
            type: "prompt_queue",
            entry: publicPromptQueueEntry(current),
            entries: snapshot.map(publicPromptQueueEntry),
          });
        },
        onError: (error) => logger.warn(`[PromptQueue] execution failed: ${error instanceof Error ? error.message : String(error)}`),
      })
    : null;
  promptQueueService?.start();

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
    const normalizedChatSessionId = normalizeLaneChatSessionId(chatSessionId);
    if (!registryKey || !normalizedChatSessionId) {
      return;
    }
    const existing = seenChatSessionIdsBySharedSession.get(registryKey);
    if (existing) {
      existing.add(normalizedChatSessionId);
      return;
    }
    seenChatSessionIdsBySharedSession.set(registryKey, new Set(["main", "advisor", normalizedChatSessionId]));
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
            // Skip browser session revalidation for connector-authenticated sockets.
            if (auth.revalidateSession && !candidate.isConnector && candidate.sessionTokenHash) {
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
    removeTaskTerminalListener();
    promptQueueService?.stop();
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const parsedProtocols = Array.isArray(protocolHeader)
      ? protocolHeader.flatMap((value) => String(value).split(",").map((p) => p.trim()).filter(Boolean))
      : typeof protocolHeader === "string"
        ? protocolHeader.split(",").map((p) => p.trim()).filter(Boolean)
        : [];

    const authResult = auth.authenticateRequest(req);
    if (!authResult.ok) {
      ws.close(4401, "unauthorized");
      return;
    }
    // Browser sessions remain subject to Origin validation. A standalone
    // connector uses an explicit Bearer credential and does not send Origin.
    if (!authResult.connector && !auth.isOriginAllowed(req, auth.allowedOrigins)) {
      ws.close(4403, "forbidden");
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
    let bindingVersion = 0;

    if (Number.isFinite(config.maxClients) && config.maxClients > 0 && state.clients.size >= config.maxClients) {
      ws.close(4409, `max clients reached (${config.maxClients})`);
      return;
    }
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.missedPongs = 0;
    aliveWs.sessionTokenHash = authResult.tokenHash;
    aliveWs.isConnector = Boolean(authResult.connector);
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

    // Always ask to reattach. When a runtime session is already in memory
    // `getOrCreate` returns it before this flag is read; when it is not, this is
    // exactly the case a saved provider session exists for. The previous
    // `!hasSession(userId)` guard looked equivalent but was not: any earlier
    // read-only `getOrCreate` (an agents broadcast, a model override) put a
    // fresh session in memory first, after which this branch never resumed
    // again and the saved thread id was stranded for the rest of the process.
    let orchestrator: WsOrchestrator;
    try {
      orchestrator = sessionManager.getOrCreate(userId, currentCwd, true, { authUserId });
    } catch (error) {
      if (!(error instanceof RuntimeBackendMismatchError)) {
        throw error;
      }
      logger.warn(
        `[WebSocket] runtime backend mismatch conn=${connectionId} session=${sessionId} chat=${chatSessionId} user=${userId} saved=${error.savedBackend} current=${error.currentBackend}`,
      );
      safeJsonSend(ws, {
        type: "error",
        code: "runtime_backend_mismatch",
        message: error.message,
        savedBackend: error.savedBackend,
        currentBackend: error.currentBackend,
      });
      ws.close(4400, "runtime backend mismatch");
      return;
    }
    const contextMode = sessionManager.getContextRestoreMode(userId);

    state.clients.add(ws);
    state.clientMetaByWs.set(ws, clientMeta);
    registerSeenChatSessionId(authUserId, sessionId, chatSessionId);
    registerSessionCacheBinding();
    try {
      clientMeta.workspaceRoot = normalizeWorkspaceRootForMeta(currentCwd);
    } catch {
      // ignore
    }

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
    const laneSyncRuntime = getLaneSyncRuntime(syncNamespace, historyKey, inFlight);
    let deltaCoalescer = laneSyncRuntime?.deltaCoalescer ?? null;
    let commandSnapshotCoalescer = laneSyncRuntime?.commandSnapshotCoalescer ?? null;
    const appendSyncEventForLane = (
      lane: WsLaneSnapshot,
      payload: unknown,
      onFailure?: () => void,
    ): { ok: boolean; payload: unknown } => {
      if (!isLaneGenerationCurrent(lane)) {
        return { ok: false, payload };
      }
      payload = projectCommandFrame(payload);
      const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
      const eventType = String(payloadRecord?.type ?? "").trim();
      if (!payloadRecord || !eventType || !syncEventStore) {
        return { ok: true, payload };
      }
      if (isTransientSyncEvent(eventType)) {
        // Live-only frames are broadcast without entering the replay log. Main
        // assistant deltas are folded into one coalesced `delta_snapshot`.
        if (eventType === "delta") {
          const source = String(payloadRecord.source ?? "").trim();
          const position = !source && lane.deltaCoalescer
            ? lane.deltaCoalescer.appendDelta(String(payloadRecord.delta ?? ""), Number(payloadRecord.ts))
            : null;
          return {
            ok: true,
            payload: {
              ...payloadRecord,
              afterSeq: syncEventStore.getLatestSeq(lane.laneNamespace, lane.historyKey),
              ...(position
                ? {
                    streamId: position.streamId,
                    startOffset: position.startOffset,
                    endOffset: position.endOffset,
                  }
                : {}),
            },
          };
        }
        return { ok: true, payload };
      }
      const streamTerminal = isStreamTerminalEvent(eventType);
      // A command is a hard phase boundary even when the provider omitted an
      // explicit phase_complete notification. Flush/seal preceding assistant
      // text before allocating the command sequence.
      if (lane.deltaCoalescer && (eventType === "command" || eventType === "phase_complete")) {
        lane.deltaCoalescer.finishPhase();
      } else if (lane.deltaCoalescer && streamTerminal) {
        lane.deltaCoalescer.finish();
      }
      let eventPayload = payloadRecord;
      if (eventType === "command" && lane.commandSnapshotCoalescer) {
        const command = payloadRecord.command && typeof payloadRecord.command === "object" && !Array.isArray(payloadRecord.command)
          ? (payloadRecord.command as Record<string, unknown>)
          : null;
        const snapshotPosition = lane.commandSnapshotCoalescer.record({
          type: "command",
          ts: payloadRecord.ts,
          command: command ?? undefined,
        });
        if (snapshotPosition && command) {
          eventPayload = {
            ...payloadRecord,
            command: {
              ...command,
              identity: snapshotPosition.identity,
              outputStartOffset: snapshotPosition.startOffset,
              outputEndOffset: snapshotPosition.endOffset,
            },
          };
        }
      }
      const eventId = String(eventPayload.eventId ?? eventPayload.event_id ?? "").trim() || undefined;
      const eventTs = Number(eventPayload.ts);
      const seq = syncEventStore.append({
        namespace: lane.laneNamespace,
        laneKey: lane.historyKey,
        type: eventType,
        eventId,
        ts: Number.isFinite(eventTs) && eventTs > 0 ? Math.floor(eventTs) : undefined,
        payload: eventPayload,
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
      if (streamTerminal) {
        lane.commandSnapshotCoalescer?.finish();
      }
      return { ok: true, payload: { ...eventPayload, seq } };
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
      const sourceChatSessionId = normalizeLaneChatSessionId(String(payloadRecord.sourceChatSessionId ?? "").trim() || null);
      // A reset is a control signal, not chat history. It has no sequence
      // number and must never enter a lane replay log, otherwise another lane
      // can consume a sequence that belongs to the source lane.
      for (const [candidate, meta] of state.clientMetaByWs.entries()) {
        if (meta.authUserId !== authUserId || meta.sessionId !== sessionId) {
          continue;
        }
        if (resetScope === "shared" && meta.chatSessionId === "advisor") {
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
        if (seenChatSessionId !== "advisor") {
          tracked.add(seenChatSessionId);
        }
      }
      for (const meta of state.clientMetaByWs.values()) {
        if (meta.authUserId !== authUserId || meta.sessionId !== sessionId) {
          continue;
        }
        const candidateChatSessionId = String(meta.chatSessionId ?? "").trim();
        if (candidateChatSessionId && candidateChatSessionId !== "advisor") {
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
      commandSnapshotCoalescer,
      bindingVersion,
    });

    const collectRuntimeSnapshots = (lane: WsLaneSnapshot, inFlightForLane: boolean): Array<Record<string, unknown>> => {
      if (!inFlightForLane) return [];
      return [
        ...(lane.deltaCoalescer?.getSnapshots?.() ?? []),
        ...(lane.commandSnapshotCoalescer?.getSnapshots?.() ?? []),
      ];
    };

    let currentLane = captureLane();

    const isCurrentLane = (lane: WsLaneSnapshot): boolean =>
      currentLane.historyKey === lane.historyKey &&
      currentLane.laneNamespace === lane.laneNamespace &&
      currentLane.laneGeneration === lane.laneGeneration &&
      currentLane.bindingVersion === lane.bindingVersion;

    const isLaneCurrent = (lane: WsLaneSnapshot): boolean =>
      isCurrentLane(lane) && isLaneGenerationCurrent(lane);

    const abortInFlightForHistoryKey = (targetHistoryKey: string): boolean =>
      abortInFlightHistory({
        interruptControllers: state.interruptControllers,
        promptRunEpochs: state.promptRunEpochs,
        historyKey: targetHistoryKey,
      });

    let resetTargets: WsResetTarget[] = [];

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
      resetTargets.push({
        authUserId: lane.authUserId,
        sessionId: lane.sessionId,
        chatSessionId: lane.chatSessionId,
        logicalHistoryKey: lane.logicalHistoryKey,
        laneGeneration: nextGeneration,
      });
      return nextGeneration;
    };

    const resetLaneStateForLane = (lane: WsLaneSnapshot): number | undefined => {
      resetTargets = [];
      return resetOneLogicalLane(lane);
    };

    const resetSharedSessionStateForLane = (_lane: WsLaneSnapshot, options: {
      sourceChatSessionId: string;
    }): { sourceGeneration?: number; laneGenerations: Record<string, number> } | undefined => {
      resetTargets = [];
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

    const rebindCurrentConnection = (target: WsResetTarget): void => {
      if (
        target.authUserId !== authUserId ||
        target.sessionId !== sessionId ||
        target.chatSessionId !== chatSessionId
      ) {
        return;
      }

      const previousLane = currentLane;
      // This is a synchronous connection-local state transition. Incrementing
      // the binding version before changing fields invalidates every async
      // operation that still holds the previous lane snapshot.
      bindingVersion += 1;
      const nextLaneResources = resolveWsLaneResources({
        chatSessionId: target.chatSessionId,
        sessions,
        history,
      });
      const nextIdentity = buildWsConnectionIdentity({
        authUserId,
        sessionId,
        chatSessionId: target.chatSessionId,
        connectionId,
        generation: target.laneGeneration,
      });
      const nextLogicalIdentity = buildWsConnectionIdentity({
        authUserId,
        sessionId,
        chatSessionId: target.chatSessionId,
        randomHex: () => "",
      });
      const workspaceRoot = state.clientMetaByWs.get(ws)?.workspaceRoot;

      chatSessionId = target.chatSessionId;
      sessionManager = nextLaneResources.sessionManager;
      historyStore = nextLaneResources.historyStore;
      getWorkspaceLock = nextLaneResources.getWorkspaceLock;
      userId = nextIdentity.userId;
      historyKey = nextIdentity.historyKey;
      cacheKey = nextIdentity.cacheKey;
      logicalHistoryKey = nextLogicalIdentity.historyKey;
      laneNamespace = resolveSyncNamespace(target.chatSessionId);
      laneGeneration = target.laneGeneration;
      clientMeta = workspaceRoot
        ? { ...nextIdentity.clientMeta, workspaceRoot, logicalHistoryKey }
        : { ...nextIdentity.clientMeta, logicalHistoryKey };
      state.clientMetaByWs.set(ws, clientMeta);
      registerSeenChatSessionId(authUserId, sessionId, chatSessionId);
      registerSessionCacheBinding();

      previousLane.deltaCoalescer?.finish();
      previousLane.commandSnapshotCoalescer?.finish();
      syncNamespace = laneNamespace;
      syncLaneKeys = resolveSyncLaneKeys({
        authUserId,
        sessionId,
        chatSessionId,
        generation: laneGeneration,
      });
      const nextInFlight = state.interruptControllers.has(historyKey);
      const nextSyncRuntime = getLaneSyncRuntime(syncNamespace, historyKey, nextInFlight);
      deltaCoalescer = nextSyncRuntime?.deltaCoalescer ?? null;
      commandSnapshotCoalescer = nextSyncRuntime?.commandSnapshotCoalescer ?? null;
      orchestrator = sessionManager.getOrCreate(userId, currentCwd, false, { authUserId });
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
        inFlight: nextInFlight,
        historyStore: currentLane.historyStore,
        historyKey: currentLane.historyKey,
        latestSeq: state.syncEventStore?.getLatestSeqForLanes(currentLane.laneNamespace, currentLane.syncLaneKeys) ?? 0,
        laneGeneration: currentLane.laneGeneration,
        runtimeSnapshots: collectRuntimeSnapshots(currentLane, nextInFlight),
      });

      logger.info(
        `[WebSocket] in-band lane reset conn=${connectionId} session=${sessionId} chat=${chatSessionId} generation=${laneGeneration} user=${userId} history=${historyKey}`,
      );
    };

    const completeAfterReset = (): void => {
      const targets = [...resetTargets];
      resetTargets = [];
      const rebound = new Set<WebSocket>();
      for (const target of targets) {
        for (const [candidate, meta] of state.clientMetaByWs.entries()) {
          if (
            rebound.has(candidate) ||
            meta.authUserId !== target.authUserId ||
            meta.sessionId !== target.sessionId ||
            meta.chatSessionId !== target.chatSessionId ||
            !historyKeyBelongsToLogicalLane(meta.historyKey, target.logicalHistoryKey)
          ) {
            continue;
          }
          rebound.add(candidate);
          const handler = inBandResetHandlers.get(candidate);
          if (handler) {
            handler(target);
          } else {
            logger.warn(
              `[WebSocket] missing in-band reset handler session=${target.sessionId} chat=${target.chatSessionId} history=${meta.historyKey}`,
            );
          }
        }
      }
    };

    inBandResetHandlers.set(ws, rebindCurrentConnection);

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
      resume: parseTranscriptResume(req.url),
      sync: state.syncEventStore ? {
        store: state.syncEventStore,
        namespace: currentLane.laneNamespace,
        laneKeys: currentLane.syncLaneKeys,
      } : undefined,
      latestSeq: state.syncEventStore?.getLatestSeqForLanes(currentLane.laneNamespace, currentLane.syncLaneKeys) ?? 0,
      laneGeneration: currentLane.laneGeneration,
      runtimeSnapshots: collectRuntimeSnapshots(currentLane, inFlight),
    });
    if (promptQueueService) {
      const entries = promptQueueService.getSnapshot({
        authUserId: currentLane.authUserId,
        sessionId: currentLane.sessionId,
        chatSessionId: currentLane.chatSessionId,
        historyKey: currentLane.historyKey,
        logicalHistoryKey: currentLane.logicalHistoryKey,
        laneNamespace: currentLane.laneNamespace,
        laneGeneration: currentLane.laneGeneration,
      });
      safeJsonSend(ws, {
        type: "prompt_queue_snapshot",
        entries: entries.map(publicPromptQueueEntry),
      });
    }

    let messageChain = Promise.resolve();
    const pendingResetBarrierTokens = new Set<ResetBarrierToken>();
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
    ): ReturnType<typeof preflightPersistAndAck> => {
      let promptQueued = false;
      const result = preflightPersistAndAck({
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
        emitUserSyncEvent: (userEv) => {
          const res = appendSyncEventForLane(lane, userEv);
          if (res.ok) broadcastJsonToHistoryKey({
            clientMetaByWs: state.clientMetaByWs,
            historyKey: lane.historyKey,
            logicalHistoryKey: lane.logicalHistoryKey,
            laneGeneration: lane.laneGeneration,
            payload: res.payload,
            sendJson: safeJsonSend,
          });
          return { ok: res.ok };
        },
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
        ...(promptQueueService && parsed.type === "prompt"
          ? {
              persistPromptQueue: () => {
                try {
                  if (!clientMessageId) {
                    return { ok: false as const, error: "Missing client message id" };
                  }
                  const payload = parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
                    ? parsed.payload as Record<string, unknown>
                    : { text: commands.sanitizeInput(parsed.payload) };
                  const queued = promptQueueService.enqueue({
                    clientMessageId,
                    authUserId: lane.authUserId,
                    userId: lane.userId,
                    sessionId: lane.sessionId,
                    chatSessionId: lane.chatSessionId,
                    historyKey: lane.historyKey,
                    logicalHistoryKey: lane.logicalHistoryKey,
                    laneNamespace: lane.laneNamespace,
                    laneGeneration: lane.laneGeneration,
                    workspaceRoot: lane.currentCwd,
                    payload,
                    retryFailed: payload.replay_incomplete === true,
                    createdAt: receivedAt,
                  });
                  promptQueued = true;
                  const current = promptQueueService.getSnapshot({
                    authUserId: lane.authUserId,
                    sessionId: lane.sessionId,
                    chatSessionId: lane.chatSessionId,
                    historyKey: lane.historyKey,
                    logicalHistoryKey: lane.logicalHistoryKey,
                    laneNamespace: lane.laneNamespace,
                    laneGeneration: lane.laneGeneration,
                  }).find((entry) => entry.clientMessageId === clientMessageId);
                  return {
                    ok: true as const,
                    duplicate: queued.duplicate,
                    status: current?.status ?? queued.entry.status,
                    position: current?.position ?? queued.entry.position,
                  };
                } catch (error) {
                  return {
                    ok: false as const,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              },
            }
          : {}),
      });
      return promptQueued ? { ...result, enqueue: false } : result;
    };

    ws.on("message", (data: RawData) => {
      const envelope = parseIncomingWsEnvelope({ data, lastReceivedAt });
      lastReceivedAt = envelope.nextReceivedAt;
      if (!envelope.ok) {
        safeJsonSend(ws, { type: "error", message: envelope.errorMessage });
        return;
      }

      const { parsed, receivedAt } = envelope;
      const clientMessageId =
        envelope.clientMessageId ??
        (parsed.type === "prompt" || parsed.type === "command"
          ? `server-${crypto.randomUUID()}`
          : null);

      if (parsed.type === "interrupt" && pendingSwitchCount > 0) {
        messageChain = messageChain
          .then(() => {
            handleImmediateForLane(currentLane, parsed, receivedAt);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[WebSocket] deferred interrupt failed conn=${connectionId} user=${currentLane.userId}: ${message}`);
          });
        return;
      }

      const isResetMessage = parsed.type === "clear_history";
      const resetBarrierToken = isResetMessage
        ? beginResetBarrier({
            authUserId,
            sessionId,
            chatSessionId,
            payload: parsed.payload,
          })
        : null;
      if (resetBarrierToken) {
        pendingResetBarrierTokens.add(resetBarrierToken);
      }
      const resetBarrierActive = !isResetMessage && Boolean(
        resetBarriers.get(resetBarrierKey(authUserId, sessionId, "shared")) ||
        resetBarriers.get(resetBarrierKey(authUserId, sessionId, "lane", chatSessionId)),
      );
      const laneAtReceipt = pendingSwitchCount === 0 && !resetBarrierActive ? currentLane : null;
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
            bindingVersion += 1;
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
            orchestrator = sessionManager.getOrCreate(userId, currentCwd, true, { authUserId });

            if (
              previousLane.historyKey !== nextIdentity.historyKey &&
              nextLaneNamespace === WEB_WORKER_NAMESPACE
            ) {
              const prevEntries = previousLane.historyStore.get(previousLane.historyKey);
              const nextExistingEntries = nextLaneRes.historyStore.get(nextIdentity.historyKey);
              if (prevEntries.length > 0 && nextExistingEntries.length === 0) {
                for (const entry of prevEntries) {
                  nextLaneRes.historyStore.add(nextIdentity.historyKey, entry);
                }
                if (prevEntries[prevEntries.length - 1]?.kind !== "session_divider") {
                  nextLaneRes.historyStore.add(nextIdentity.historyKey, {
                    role: "status",
                    kind: "session_divider",
                    text: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
                    ts: Date.now(),
                  });
                }
              }
            }

            const nextSyncLaneKeys = resolveSyncLaneKeys({
              authUserId,
              sessionId,
              chatSessionId,
              generation: laneGeneration,
            });
            deltaCoalescer?.finish();
            commandSnapshotCoalescer?.finish();
            syncNamespace = nextLaneNamespace;
            syncLaneKeys = nextSyncLaneKeys;
            const nextInFlight = state.interruptControllers.has(historyKey);
            const nextSyncRuntime = getLaneSyncRuntime(
              syncNamespace,
              historyKey,
              nextInFlight,
            );
            deltaCoalescer = nextSyncRuntime?.deltaCoalescer ?? null;
            commandSnapshotCoalescer = nextSyncRuntime?.commandSnapshotCoalescer ?? null;
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
              inFlight: nextInFlight,
              historyStore: currentLane.historyStore,
              historyKey: currentLane.historyKey,
              latestSeq: state.syncEventStore?.getLatestSeqForLanes(currentLane.laneNamespace, currentLane.syncLaneKeys) ?? 0,
              laneGeneration: currentLane.laneGeneration,
              runtimeSnapshots: collectRuntimeSnapshots(currentLane, nextInFlight),
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
          try {
            if (!isResetMessage) {
              await waitForResetBarriers({
                authUserId,
                sessionId,
                chatSessionId: currentLane.chatSessionId,
              });
            }
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
                completeAfterReset,
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
          } finally {
            if (resetBarrierToken) {
              pendingResetBarrierTokens.delete(resetBarrierToken);
            }
            releaseResetBarrier(resetBarrierToken);
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
      for (const token of pendingResetBarrierTokens) {
        releaseResetBarrier(token);
      }
      pendingResetBarrierTokens.clear();
      inBandResetHandlers.delete(ws);
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

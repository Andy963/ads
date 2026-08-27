import { AdsWebSocket } from "../../api/ws";
import type { SyncEventsResponse } from "../../api/types";
import {
  buildModelIdStorageKey,
  buildReasoningEffortStorageKey,
  normalizeModelId,
  normalizeReasoningEffort,
} from "../../lib/chatPreferences";

import type { AppContext, PathValidateResponse, ProjectRuntime, ProjectTab } from "../controller";
import type { ChatActions } from "../chat";

import type { WsDeps } from "./types";
import { isReconnectNotice, pickReconnectNotice } from "./reconnectNotice";
import { createSyncEventSequencer } from "./syncSequencer";
import { createWsMessageHandler } from "./wsMessage";

const TERMINAL_BOOTSTRAP_COVERED_EVENT_TYPES = new Set([
  "history",
  "in_flight",
  "delta",
  "delta_snapshot",
  "result",
  "error",
  "status",
  "command",
  "patch",
  "explored",
  "plan",
  "agent",
  "task:event",
]);

export function createWebSocketActions(ctx: AppContext & ChatActions, deps: WsDeps) {
  const {
    api,
    loggedIn,
    projects,
    activeProjectId,
    pendingSwitchProjectId,
    runtimeByProjectId,
    plannerRuntimeByProjectId,
    normalizeProjectId,
    getRuntime,
    getPlannerRuntime,
    maxTurnCommands,
  } = ctx;

  const {
    clearStepLive,
    finalizeCommandBlock,
    applyStreamingDisconnectCleanup,
    pushMessageBeforeLive,
    restorePendingPrompt,
    flushQueuedPrompts,
    applyResumeHistory,
    cancelPendingResume,
    shouldIgnoreStepDelta,
    upsertStepLiveDelta,
    upsertStreamingDelta,
    replaceStreamingText,
    ingestExploredActivity,
    upsertLiveActivity,
    clearPendingPrompt,
    clearPendingPromptReplayState,
    threadReset,
    finalizeAssistant,
    commandKeyForWsEvent,
    ingestCommand,
    upsertExecuteBlock,
    ingestCommandActivity,
  } = ctx;

  const restoreReasoningEffort = (rt: ProjectRuntime): void => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    if (!sessionId) return;
    const key = buildReasoningEffortStorageKey(sessionId, rt.chatSessionId);
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        rt.modelReasoningEffort.value = normalizeReasoningEffort(stored);
      }
    } catch {
      // ignore
    }
  };

  const restoreModelId = (rt: ProjectRuntime): void => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    if (!sessionId) return;
    const key = buildModelIdStorageKey(sessionId, rt.chatSessionId);
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        rt.modelId.value = normalizeModelId(stored);
      }
    } catch {
      // ignore
    }
  };

  const clearReconnectTimer = (rt: { reconnectTimer: number | null }): void => {
    if (rt.reconnectTimer === null) return;
    try {
      clearTimeout(rt.reconnectTimer);
    } catch {
      // ignore
    }
    rt.reconnectTimer = null;
  };

  const closeRuntimeConnection = (rt: {
    reconnectTimer: number | null;
    ws: { close: () => void } | null;
    connected: { value: boolean };
    syncGeneration: number;
    syncInProgress: boolean;
  }): void => {
    clearReconnectTimer(rt);
    rt.syncGeneration += 1;
    rt.syncInProgress = false;
    const prev = rt.ws;
    rt.ws = null;
    try {
      prev?.close();
    } catch {
      // ignore
    }
    rt.connected.value = false;
  };

  const closeAllConnections = (): void => {
    for (const rt of runtimeByProjectId.values()) {
      closeRuntimeConnection(rt);
    }
    for (const rt of plannerRuntimeByProjectId.values()) {
      closeRuntimeConnection(rt);
    }
  };

  const mergeProjectsInto = (target: ProjectTab, candidate: ProjectTab): ProjectTab => {
    const name = target.name || candidate.name;
    const initialized = target.initialized || candidate.initialized;
    const createdAt = Math.min(target.createdAt, candidate.createdAt);
    const updatedAt = Date.now();
    return { ...target, ...candidate, name, initialized, createdAt, updatedAt };
  };

  const replaceProjectId = (oldId: string, next: ProjectTab): void => {
    const current = projects.value.slice();
    const existingIdx = current.findIndex((p) => p.id === next.id);
    const oldIdx = current.findIndex((p) => p.id === oldId);
    if (oldIdx < 0) {
      return;
    }

    if (existingIdx >= 0 && existingIdx !== oldIdx) {
      const merged = mergeProjectsInto(current[existingIdx]!, next);
      current[existingIdx] = merged;
      current.splice(oldIdx, 1);
    } else {
      current[oldIdx] = next;
    }

    projects.value = current;
    if (activeProjectId.value === oldId) {
      activeProjectId.value = next.id;
    }
    if (pendingSwitchProjectId.value === oldId) {
      pendingSwitchProjectId.value = next.id;
    }
    const oldKey = normalizeProjectId(oldId);
    const nextKey = normalizeProjectId(next.id);
    if (oldKey !== nextKey) {
      const rt = runtimeByProjectId.get(oldKey);
      if (rt) {
        if (!runtimeByProjectId.has(nextKey)) {
          runtimeByProjectId.set(nextKey, rt);
        }
        runtimeByProjectId.delete(oldKey);
      }
      const plannerRt = plannerRuntimeByProjectId.get(oldKey);
      if (plannerRt) {
        if (!plannerRuntimeByProjectId.has(nextKey)) {
          plannerRuntimeByProjectId.set(nextKey, plannerRt);
        }
        plannerRuntimeByProjectId.delete(oldKey);
      }
    }
    deps.persistProjects();
  };

  const resolveProjectIdentity = async (project: ProjectTab): Promise<{ sessionId: string; path: string } | null> => {
    if (String(project.id ?? "").trim() === "default") {
      return null;
    }
    const rawPath = String(project.path ?? "").trim();
    if (!rawPath) {
      return null;
    }
    try {
      const result = await api.get<PathValidateResponse>(`/api/paths/validate?path=${encodeURIComponent(rawPath)}`);
      if (!result.ok) {
        return null;
      }
      const sessionId = String(result.projectSessionId ?? "").trim();
      if (!sessionId) {
        return null;
      }
      const workspaceRoot = String(result.workspaceRoot ?? "").trim();
      const resolvedPath = String(result.resolvedPath ?? "").trim();
      const normalizedPath = workspaceRoot || resolvedPath || rawPath;
      return { sessionId, path: normalizedPath };
    } catch {
      return null;
    }
  };

  type WsMode = "worker" | "planner";

  const resolveChatSessionId = (project: ProjectTab, mode: WsMode): string => {
    if (mode === "planner") {
      return "planner";
    }
    return String(project.chatSessionId ?? "").trim() || "main";
  };

  const syncCursorKey = (rt: ProjectRuntime): string | null => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    return sessionId ? `ads.syncCursor.${sessionId}.${chatSessionId}` : null;
  };

  const readSyncCursor = (rt: ProjectRuntime): number => {
    const key = syncCursorKey(rt);
    if (!key) return 0;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as { lastSeq?: unknown };
      const seq = Number(parsed.lastSeq);
      return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
    } catch {
      return 0;
    }
  };

  const writeSyncCursor = (rt: ProjectRuntime, seq: number): void => {
    const key = syncCursorKey(rt);
    if (!key) return;
    try {
      const lastSeq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
      if (lastSeq === 0) {
        sessionStorage.removeItem(key);
        return;
      }
      sessionStorage.setItem(key, JSON.stringify({ lastSeq, updatedAt: Date.now() }));
    } catch {
      // ignore
    }
  };

  const syncEventsPath = (rt: ProjectRuntime, project: ProjectTab, afterSeq: number): string | null => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    if (!sessionId) return null;
    const params = new URLSearchParams({
      sessionId,
      chatSessionId,
      afterSeq: String(Math.max(0, Math.floor(afterSeq))),
      limit: "500",
    });
    const isDefaultProject = String(project.id ?? project.sessionId ?? "").trim() === "default";
    const workspaceRoot = isDefaultProject
      ? ""
      : String(project.path ?? rt.workspacePath.value ?? "").trim();
    if (workspaceRoot) params.set("workspace", workspaceRoot);
    return `/api/sync/events?${params.toString()}`;
  };

  const scheduleReconnect = (
    mode: WsMode,
    projectId: string,
    rt: { reconnectTimer: number | null; reconnectAttempts: number },
    reason: string,
  ): void => {
    void reason;
    if (!loggedIn.value) return;
    if (rt.reconnectTimer !== null) return;

    const attempt = Math.min(6, rt.reconnectAttempts);
    const delayMs = Math.min(15_000, 800 * Math.pow(2, attempt));
    rt.reconnectAttempts += 1;
    rt.reconnectTimer = window.setTimeout(() => {
      rt.reconnectTimer = null;
      const connectFn = mode === "planner" ? connectPlannerWs : connectWs;
      void connectFn(projectId).catch(() => {
        scheduleReconnect(mode, projectId, rt, "connect failed");
      });
    }, delayMs);
  };

  const getRuntimeForMode = (mode: WsMode, pid: string): ProjectRuntime => {
    if (mode === "planner") {
      return getPlannerRuntime(pid);
    }
    return getRuntime(pid);
  };

  const connectWsInternal = async (mode: WsMode, projectId: string = activeProjectId.value): Promise<void> => {
    if (!loggedIn.value) return;
    let pid = normalizeProjectId(projectId);
    let project = projects.value.find((p) => p.id === pid) ?? null;
    if (!project) return;

    const chatSessionId = resolveChatSessionId(project, mode);
    const initialRt = getRuntimeForMode(mode, pid);
    let rt = initialRt;
    rt.inputLocked ??= { value: false };
    rt.laneStatus ??= { value: null };
    rt.projectSessionId = String(project.sessionId ?? "").trim();
    rt.chatSessionId = chatSessionId;
    restoreReasoningEffort(rt);
    restoreModelId(rt);
    rt.syncGeneration += 1;
    rt.syncInProgress = false;

    clearReconnectTimer(rt);

    const prev = rt.ws as { close: () => void } | null;
    rt.ws = null;
    try {
      prev?.close();
    } catch {
      // ignore
    }

    const provisionalWs = new AdsWebSocket({ sessionId: project.sessionId, chatSessionId: rt.chatSessionId });
    rt.ws = provisionalWs;

    const identity = await resolveProjectIdentity(project);
    if (initialRt.ws !== provisionalWs) {
      // Runtime was closed or superseded while resolving project identity. Avoid reconnecting.
      return;
    }

    const identityChanged = Boolean(identity && (identity.sessionId !== project.sessionId || identity.path !== project.path));
    if (identity && (identity.sessionId !== project.sessionId || identity.path !== project.path)) {
      const nextProject: ProjectTab = {
        ...project,
        id: identity.sessionId,
        sessionId: identity.sessionId,
        path: identity.path,
        updatedAt: Date.now(),
      };
      replaceProjectId(project.id, nextProject);
      pid = nextProject.id;
      project = nextProject;
    }

    rt = getRuntimeForMode(mode, pid);
    if (rt !== initialRt) {
      rt.syncGeneration += 1;
      rt.syncInProgress = false;
    }
    rt.projectSessionId = String(project.sessionId ?? "").trim();
    rt.chatSessionId = resolveChatSessionId(project, mode);
    restoreReasoningEffort(rt);
    restoreModelId(rt);

    let wsInstance = provisionalWs;
    if (identityChanged || rt !== initialRt) {
      if (rt !== initialRt && initialRt.ws === provisionalWs) {
        try {
          provisionalWs.close();
        } catch {
          // ignore
        }
        initialRt.ws = null;
      }

      clearReconnectTimer(rt);
      const prevFinal = rt.ws as { close: () => void } | null;
      rt.ws = null;
      try {
        prevFinal?.close();
      } catch {
        // ignore
      }

      wsInstance = new AdsWebSocket({ sessionId: project.sessionId, chatSessionId: rt.chatSessionId });
      rt.ws = wsInstance;
    }

    rt.ws = wsInstance;
    const syncGeneration = rt.syncGeneration;
    let disconnectCleanupDone = false;
    let disconnectWasBusy = false;
    const shouldSyncTasks = mode === "worker";
    let handleWsPayload: ((msg: unknown) => void) | null = null;
    let deferredBootstrapHistory: Record<string, unknown> | null = null;
    let bootstrapBoundarySeq = 0;
    let bootstrapReportedInFlight: boolean | null = null;
    let bootstrapHistoryExpected = false;
    let bootstrapHistoryWait: Promise<void> | null = null;
    let resolveBootstrapHistoryWait: (() => void) | null = null;
    let syncRetryTimer: number | null = null;
    let syncRetryAttempts = 0;
    const sequencer = createSyncEventSequencer({
      initialCursor: readSyncCursor(rt),
      writeCursor: (seq) => writeSyncCursor(rt, seq),
    });

    const isCurrentSync = (): boolean =>
      rt.ws === wsInstance && rt.syncGeneration === syncGeneration && rt.connected.value;

    const clearSyncRetryTimer = (): void => {
      if (syncRetryTimer === null) return;
      try {
        clearTimeout(syncRetryTimer);
      } catch {
        // ignore
      }
      syncRetryTimer = null;
    };

    const expectBootstrapHistory = (): void => {
      bootstrapHistoryExpected = true;
      if (bootstrapHistoryWait) return;
      bootstrapHistoryWait = new Promise<void>((resolve) => {
        resolveBootstrapHistoryWait = resolve;
      });
    };

    const finishBootstrapHistoryWait = (): void => {
      resolveBootstrapHistoryWait?.();
      resolveBootstrapHistoryWait = null;
    };

    const waitForBootstrapHistory = async (): Promise<void> => {
      if (!bootstrapHistoryExpected || !bootstrapHistoryWait) return;
      await bootstrapHistoryWait;
    };

    const showSyncRecoveryNotice = (): void => {
      rt.apiNotice.value = "同步记录窗口已过期，已从后端快照恢复。";
      if (rt.noticeTimer !== null) {
        try {
          clearTimeout(rt.noticeTimer);
        } catch {
          // ignore
        }
      }
      rt.noticeTimer = window.setTimeout(() => {
        rt.noticeTimer = null;
        rt.apiNotice.value = null;
      }, 3000);
    };

    const applySyncPayload = (payload: Record<string, unknown>): void => {
      if (payload.type === "task:event") {
        deps.onTaskEvent(
          {
            event: payload.event,
            data: payload.data,
            seq: payload.seq,
          },
          rt,
        );
        return;
      }
      handleWsPayload?.(payload);
    };

    const hasTerminalAssistantHistory = (payload: Record<string, unknown>): boolean => {
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const role = String((item as Record<string, unknown>).role ?? "").trim();
        const text = String((item as Record<string, unknown>).text ?? "").trim();
        if (!role || !text) continue;
        if (role === "ai") return true;
        if (role === "user") return false;
      }
      return false;
    };

    const scheduleSyncRetry = (): void => {
      if (!isCurrentSync() || syncRetryTimer !== null) return;
      const delayMs = Math.min(15_000, 800 * Math.pow(2, Math.min(6, syncRetryAttempts)));
      syncRetryAttempts += 1;
      syncRetryTimer = window.setTimeout(() => {
        syncRetryTimer = null;
        if (!isCurrentSync() || !rt.needsChatSync) return;
        void syncChatEvents();
      }, delayMs);
    };

    async function syncChatEvents(): Promise<void> {
      if (rt.syncInProgress || !isCurrentSync()) return;
      const path = syncEventsPath(rt, project, sequencer.getLastAppliedSeq());
      if (!path) return;
      sequencer.beginCatchUp();
      rt.syncInProgress = true;
      try {
        let completed = false;
        const catchUpStartSeq = sequencer.getLastAppliedSeq();
        let afterSeq = catchUpStartSeq;
        const catchUpPayloads: Record<string, unknown>[] = [];
        for (let page = 0; page < 20; page++) {
          const pagePath = syncEventsPath(rt, project, afterSeq);
          if (!pagePath) throw new Error("Sync path is unavailable");
          const response = await api.get<Partial<SyncEventsResponse>>(pagePath);
          if (!isCurrentSync()) return;
          if (response.truncated) {
            await waitForBootstrapHistory();
            if (!isCurrentSync()) return;
            const latestSeq = Number(response.latestSeq);
            const snapshot = response.snapshot;
            sequencer.replaceWithSnapshot(
              Number.isFinite(latestSeq) && latestSeq > 0 ? Math.floor(latestSeq) : 0,
              () => {
                clearStepLive(rt);
                finalizeCommandBlock(rt);
                rt.messages.value = [];
                rt.recentCommands.value = [];
                rt.seenCommandIds.clear();
                rt.executePreviewByKey.clear();
                rt.executeOrder = [];
                rt.turnCommands = [];
                rt.turnCommandCount = 0;
                if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
                  applySyncPayload(snapshot);
                }
              },
            );
            showSyncRecoveryNotice();
            deferredBootstrapHistory = null;
            bootstrapHistoryExpected = false;
            bootstrapHistoryWait = null;
            rt.needsTaskResync = shouldSyncTasks;
            completed = true;
            break;
          }
          const events = Array.isArray(response.events) ? response.events : [];
          for (const event of events) {
            const seq = Number(event.seq);
            if (!Number.isFinite(seq) || seq <= afterSeq) continue;
            const eventTs = Number(event.ts);
            const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
              ? {
                  ...event.payload,
                  ...(!Object.prototype.hasOwnProperty.call(event.payload, "ts") && Number.isFinite(eventTs) && eventTs > 0
                    ? { ts: Math.floor(eventTs) }
                    : {}),
                  seq,
                }
              : { type: event.type, ...(Number.isFinite(eventTs) && eventTs > 0 ? { ts: Math.floor(eventTs) } : {}), seq };
            catchUpPayloads.push(payload);
            afterSeq = Math.floor(seq);
          }
          if (!response.hasMore) {
            completed = true;
            break;
          }
          if (events.length === 0) throw new Error("Sync response hasMore without events");
        }
        if (!completed) throw new Error("Sync catch-up exceeded page limit");
        await waitForBootstrapHistory();
        if (!isCurrentSync()) return;
        rt.needsChatSync = false;
        const bootstrapHistory = deferredBootstrapHistory;
        deferredBootstrapHistory = null;
        bootstrapHistoryExpected = false;
        bootstrapHistoryWait = null;
        const bootstrapHasTerminalAssistant = Boolean(
          bootstrapHistory && hasTerminalAssistantHistory(bootstrapHistory),
        );
        const terminalBootstrapIsAuthoritative =
          bootstrapHasTerminalAssistant && bootstrapReportedInFlight === false;
        if (bootstrapHistory) {
          handleWsPayload?.(bootstrapHistory);
        }
        const terminalPatchSeqs = new Set<number>();
        let finalTerminalPatchSeq = 0;
        if (terminalBootstrapIsAuthoritative) {
          let terminalResultIndex = -1;
          for (let index = catchUpPayloads.length - 1; index >= 0; index -= 1) {
            const payload = catchUpPayloads[index]!;
            const seq = Number(payload.seq);
            if (!Number.isFinite(seq) || seq > bootstrapBoundarySeq) continue;
            if (
              String(payload.type ?? "").trim() === "result" &&
              payload.ok === true &&
              !String(payload.kind ?? "").trim()
            ) {
              terminalResultIndex = index;
              break;
            }
          }
          if (terminalResultIndex >= 0) {
            let terminalTurnStartSeq = catchUpStartSeq;
            for (let index = terminalResultIndex - 1; index >= 0; index -= 1) {
              const payload = catchUpPayloads[index]!;
              const seq = Number(payload.seq);
              if (!Number.isFinite(seq)) continue;
              const type = String(payload.type ?? "").trim();
              if (type === "in_flight" && payload.inFlight === true) {
                terminalTurnStartSeq = Math.floor(seq);
                break;
              }
              if (type === "result") {
                terminalTurnStartSeq = Math.floor(seq) + 1;
                break;
              }
            }
            const terminalResultSeq = Number(catchUpPayloads[terminalResultIndex]!.seq);
            for (const payload of catchUpPayloads) {
              const seq = Number(payload.seq);
              if (
                String(payload.type ?? "").trim() === "patch" &&
                Number.isFinite(seq) &&
                seq >= terminalTurnStartSeq &&
                seq <= terminalResultSeq
              ) {
                const normalizedSeq = Math.floor(seq);
                terminalPatchSeqs.add(normalizedSeq);
                finalTerminalPatchSeq = normalizedSeq;
              }
            }
          }
        }
        for (const payload of catchUpPayloads) {
          const seq = Number(payload.seq);
          const type = String(payload.type ?? "").trim();
          const withinTerminalBootstrapBoundary =
            terminalBootstrapIsAuthoritative &&
            Number.isFinite(seq) &&
            seq <= bootstrapBoundarySeq;
          const normalizedSeq = Number.isFinite(seq) ? Math.floor(seq) : 0;
          const replayTerminalPatch = terminalPatchSeqs.has(normalizedSeq);
          const coveredByTerminalBootstrap =
            withinTerminalBootstrapBoundary &&
            TERMINAL_BOOTSTRAP_COVERED_EVENT_TYPES.has(type);
          sequencer.applyCatchUp(payload, () => {
            if (replayTerminalPatch) {
              applySyncPayload({
                ...payload,
                syncReplayMode: "terminal-artifact",
                syncReplayFinal: normalizedSeq === finalTerminalPatchSeq,
              });
            } else if (!coveredByTerminalBootstrap) {
              applySyncPayload(payload);
            }
          });
        }
        sequencer.completeCatchUp();
        syncRetryAttempts = 0;
        clearSyncRetryTimer();
        if (shouldSyncTasks && rt.needsTaskResync) {
          rt.needsTaskResync = false;
          void deps.syncProjectState?.(pid).catch(() => {
            rt.needsTaskResync = true;
          });
        }
      } catch {
        if (rt.ws === wsInstance && rt.syncGeneration === syncGeneration) {
          rt.needsChatSync = true;
          scheduleSyncRetry();
        }
      } finally {
        if (rt.syncGeneration === syncGeneration) {
          rt.syncInProgress = false;
        }
      }
    }

    const dropReconnectBusyMessage = () => {
      const items = rt.messages.value;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (item.role === "system" && item.kind === "text" && isReconnectNotice(String(item.content ?? ""))) {
          rt.messages.value = [...items.slice(0, i), ...items.slice(i + 1)];
          return;
        }
      }
    };

    const cleanupTerminalCloseState = () => {
      clearReconnectTimer(rt);
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      rt.inputLocked.value = false;
      rt.laneStatus.value = null;
      clearPendingPromptReplayState(rt);
      dropReconnectBusyMessage();
    };

    const cleanupDisconnectState = (options?: { showReconnectMessage?: boolean }) => {
      const showReconnectMessage = options?.showReconnectMessage ?? true;
      if (disconnectCleanupDone) return;
      disconnectCleanupDone = true;
      disconnectWasBusy = rt.busy.value;
      rt.needsTaskResync = true;
      rt.needsChatSync = true;
      rt.connected.value = false;
      clearSyncRetryTimer();
      finishBootstrapHistoryWait();
      clearStepLive(rt);
      applyStreamingDisconnectCleanup(rt);
      finalizeCommandBlock(rt);
      if (disconnectWasBusy && showReconnectMessage) {
        const reconnectContent = pickReconnectNotice({
          hasPendingAck: Boolean(String(rt.pendingAckClientMessageId ?? "").trim()),
        });
        rt.inputLocked.value = true;
        rt.laneStatus.value = { kind: "progress", message: reconnectContent };
      }
    };

    wsInstance.onOpen = () => {
      if (rt.ws !== wsInstance) return;
      rt.connected.value = true;
      rt.wsError.value = null;
      rt.reconnectAttempts = 0;
      rt.awaitingBootstrapHistory = false;
      clearReconnectTimer(rt);
      restorePendingPrompt(rt);
      if (shouldSyncTasks && rt.needsTaskResync) {
        rt.needsTaskResync = false;
        void deps.syncProjectState?.(pid).catch(() => {
          // Best-effort: if sync fails we still keep the connection; next reconnect will retry.
          rt.needsTaskResync = true;
        });
      }
    };

    wsInstance.onClose = (ev) => {
      if (rt.ws !== wsInstance) return;
      const terminalClose = ev.code === 4401 || ev.code === 4409;
      cleanupDisconnectState({ showReconnectMessage: !terminalClose });

      if (ev.code === 4401) {
        cleanupTerminalCloseState();
        rt.wsError.value = "Unauthorized";
        return;
      }
      if (ev.code === 4409) {
        cleanupTerminalCloseState();
        rt.wsError.value = "Max clients reached (increase ADS_WEB_MAX_CLIENTS)";
        return;
      }

      const reason = String((ev as CloseEvent).reason ?? "").trim();
      rt.wsError.value = `WebSocket closed (${ev.code || "unknown"})${reason ? `: ${reason}` : ""}`;
      scheduleReconnect(mode, pid, rt, "close");
    };

    wsInstance.onError = () => {
      if (rt.ws !== wsInstance) return;
      cleanupDisconnectState();
      rt.wsError.value = "WebSocket error";
      scheduleReconnect(mode, pid, rt, "error");
    };

    if (mode === "worker") {
      wsInstance.onTaskEvent = (payload) => {
        if (rt.ws !== wsInstance) return;
        const sequencedPayload = { type: "task:event", ...payload };
        sequencer.observe(sequencedPayload, () => deps.onTaskEvent(payload, rt));
      };
    }

    const handleMessage = createWsMessageHandler({
      projects,
      pid,
      rt,
      wsInstance,
      maxTurnCommands,
      randomId: ctx.randomId,
      updateProject: deps.updateProject,
      applyResumeHistory,
      cancelPendingResume,
      clearPendingPrompt,
      clearStepLive,
      commandKeyForWsEvent,
      finalizeAssistant,
      finalizeCommandBlock,
      flushQueuedPrompts,
      ingestCommand,
      ingestCommandActivity,
      ingestExploredActivity,
      pushMessageBeforeLive,
      shouldIgnoreStepDelta,
      threadReset,
      upsertExecuteBlock,
      upsertLiveActivity,
      upsertStepLiveDelta,
      upsertStreamingDelta,
      replaceStreamingText,
    });
    handleWsPayload = handleMessage;

    wsInstance.onMessage = (msg) => {
      if (rt.ws !== wsInstance) return;
      if (msg && typeof msg === "object" && !Array.isArray(msg)) {
        const rec = msg as Record<string, unknown>;
        const seq = Number(rec.seq);
        if (rec.type === "history" && sequencer.isBuffering() && !(Number.isFinite(seq) && seq > 0)) {
          deferredBootstrapHistory = rec;
          finishBootstrapHistoryWait();
          return;
        }
      }
      sequencer.observe(msg, () => handleMessage(msg));
      if (msg && typeof msg === "object" && !Array.isArray(msg)) {
        const rec = msg as Record<string, unknown>;
        const latestSeq = Number(rec.latestSeq);
        if (rec.type === "welcome") {
          if (typeof rec.inFlight === "boolean") {
            bootstrapReportedInFlight = rec.inFlight;
          }
          if (Number.isFinite(latestSeq) && latestSeq > 0) {
            bootstrapBoundarySeq = Math.floor(latestSeq);
          }
          if (Number.isFinite(latestSeq) && latestSeq > sequencer.getLastAppliedSeq()) {
            rt.needsChatSync = true;
            sequencer.beginCatchUp();
            if (rec.bootstrapHistory === true) expectBootstrapHistory();
            void syncChatEvents();
          } else {
            rt.needsChatSync = false;
          }
        }
      }
    };

    wsInstance.connect();
  };

  const connectWs = async (projectId: string = activeProjectId.value): Promise<void> =>
    connectWsInternal("worker", projectId);

  const connectPlannerWs = async (projectId: string = activeProjectId.value): Promise<void> =>
    connectWsInternal("planner", projectId);

  return {
    clearReconnectTimer,
    closeRuntimeConnection,
    closeAllConnections,
    connectWs,
    connectPlannerWs,
  };
}

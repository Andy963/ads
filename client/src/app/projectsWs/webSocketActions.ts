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
  "command_snapshot",
  "patch",
  "explored",
  "plan",
  "agent",
  "phase_complete",
]);
const BOOTSTRAP_HISTORY_WATCHDOG_MS = 5000;

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
    sealActiveStreamingAssistant,
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
    setMessages,
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

  const syncCursorKey = (rt: ProjectRuntime, chatSessionIdOverride?: string): string | null => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(chatSessionIdOverride ?? rt.chatSessionId ?? "").trim() || "main";
    return sessionId ? `ads.syncCursor.${sessionId}.${chatSessionId}` : null;
  };

  const taskSyncCursorKey = (rt: ProjectRuntime): string | null => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    return sessionId ? `ads.taskSyncCursor.${sessionId}` : null;
  };

  const laneGenerationKey = (rt: ProjectRuntime, chatSessionIdOverride?: string): string | null => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(chatSessionIdOverride ?? rt.chatSessionId ?? "").trim() || "main";
    return sessionId ? `ads.laneGeneration.${sessionId}.${chatSessionId}` : null;
  };

  const laneGenerationScopeKey = (rt: ProjectRuntime, chatSessionIdOverride?: string): string => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(chatSessionIdOverride ?? rt.chatSessionId ?? "").trim() || "main";
    return `${sessionId}::${chatSessionId}`;
  };

  const readLaneGeneration = (rt: ProjectRuntime, chatSessionIdOverride?: string): number | null => {
    const key = laneGenerationKey(rt, chatSessionIdOverride);
    if (!key) return null;
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
    } catch {
      return null;
    }
  };

  const writeLaneGeneration = (rt: ProjectRuntime, generation: number, chatSessionIdOverride?: string): void => {
    const key = laneGenerationKey(rt, chatSessionIdOverride);
    if (!key) return;
    try {
      localStorage.setItem(key, String(Math.max(1, Math.floor(generation))));
    } catch {
      // ignore
    }
  };

  const clearOutboxForGenerationChange = (rt: ProjectRuntime): void => {
    rt.queuedPrompts.value = [];
    rt.pendingAckClientMessageId = null;
    clearPendingPrompt(rt);
  };

  const readSyncCursor = (rt: ProjectRuntime, chatSessionIdOverride?: string): number => {
    const key = syncCursorKey(rt, chatSessionIdOverride);
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

  const writeSyncCursor = (rt: ProjectRuntime, seq: number, chatSessionIdOverride?: string): void => {
    const key = syncCursorKey(rt, chatSessionIdOverride);
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

  const readTaskSyncCursor = (rt: ProjectRuntime): number => {
    const key = taskSyncCursorKey(rt);
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

  const writeTaskSyncCursor = (rt: ProjectRuntime, seq: number): void => {
    const key = taskSyncCursorKey(rt);
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

  const syncEventsPath = (
    rt: ProjectRuntime,
    project: ProjectTab,
    afterSeq: number,
    channel: "chat" | "tasks" = "chat",
    chatSessionIdOverride?: string,
  ): string | null => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(chatSessionIdOverride ?? rt.chatSessionId ?? "").trim() || "main";
    if (!sessionId) return null;
    const params = new URLSearchParams({
      sessionId,
      chatSessionId,
      afterSeq: String(Math.max(0, Math.floor(afterSeq))),
      limit: "500",
    });
    if (channel === "tasks") params.set("channel", "tasks");
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
    const initialLaneGenerationScope = laneGenerationScopeKey(rt, chatSessionId);
    if (rt.laneGenerationScope !== initialLaneGenerationScope) {
      rt.laneGeneration = readLaneGeneration(rt, chatSessionId) ?? undefined;
      rt.laneGenerationScope = initialLaneGenerationScope;
      rt.lastConsumedResetGeneration = undefined;
      rt.legacySessionResetConsumed = false;
    }
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
    const finalLaneGenerationScope = laneGenerationScopeKey(rt, rt.chatSessionId);
    if (rt.laneGenerationScope !== finalLaneGenerationScope) {
      rt.laneGeneration = readLaneGeneration(rt, rt.chatSessionId) ?? undefined;
      rt.laneGenerationScope = finalLaneGenerationScope;
      rt.lastConsumedResetGeneration = undefined;
      rt.legacySessionResetConsumed = false;
    }
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
    type DeferredBootstrapHistory = {
      payload: Record<string, unknown>;
      seq: number | null;
      afterSeq: number | null;
      arrivalOrder: number;
    };
    let deferredBootstrapHistory: DeferredBootstrapHistory[] = [];
    let bootstrapHistoryArrivalOrder = 0;
    let bootstrapHistoryApplyScheduled = false;
    let deferredRuntimeSnapshots: Record<string, unknown>[] = [];
    let bootstrapBoundarySeq = 0;
    let bootstrapReportedInFlight: boolean | null = null;
    let bootstrapHistoryExpected = false;
    let bootstrapHistoryWait: Promise<void> | null = null;
    let resolveBootstrapHistoryWait: (() => void) | null = null;
    let bootstrapHistoryWatchdogTimer: number | null = null;
    let syncRetryTimer: number | null = null;
    let syncRetryAttempts = 0;
    let taskSyncRetryTimer: number | null = null;
    let taskSyncRetryAttempts = 0;
    let syncChatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    let syncLaneEpoch = 0;
    const createChatSequencer = (chatSessionId: string) =>
      createSyncEventSequencer({
        initialCursor: readSyncCursor(rt, chatSessionId),
        writeCursor: (seq) => writeSyncCursor(rt, seq, chatSessionId),
      });
    let sequencer = createChatSequencer(syncChatSessionId);
    const taskSequencer = createSyncEventSequencer({
      initialCursor: readTaskSyncCursor(rt),
      writeCursor: (seq) => writeTaskSyncCursor(rt, seq),
    });
    let taskSyncInProgress = false;
    let needsTaskEventSync = false;

    const isCurrentSync = (expectedLaneEpoch: number = syncLaneEpoch): boolean =>
      rt.ws === wsInstance &&
      rt.syncGeneration === syncGeneration &&
      rt.connected.value &&
      expectedLaneEpoch === syncLaneEpoch;

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

    const selectBootstrapHistory = (): Record<string, unknown> | null => {
      if (deferredBootstrapHistory.length === 0) return null;
      const candidates = deferredBootstrapHistory.slice().sort((left, right) => {
        const leftBarrier = left.seq ?? left.afterSeq ?? -1;
        const rightBarrier = right.seq ?? right.afterSeq ?? -1;
        return leftBarrier - rightBarrier || left.arrivalOrder - right.arrivalOrder;
      });
      return candidates[candidates.length - 1]?.payload ?? null;
    };

    const clearDeferredBootstrapHistory = (): void => {
      deferredBootstrapHistory = [];
    };

    const clearDeferredRuntimeSnapshots = (): void => {
      deferredRuntimeSnapshots = [];
    };

    const applyDeferredRuntimeSnapshots = (): void => {
      if (deferredRuntimeSnapshots.length === 0) return;
      const snapshots = deferredRuntimeSnapshots.slice();
      deferredRuntimeSnapshots = [];
      snapshots.sort((left, right) => {
        const leftBarrier = Number(left.afterSeq ?? left.snapshotSeq ?? 0);
        const rightBarrier = Number(right.afterSeq ?? right.snapshotSeq ?? 0);
        return (Number.isFinite(leftBarrier) ? leftBarrier : 0) - (Number.isFinite(rightBarrier) ? rightBarrier : 0);
      });
      for (const snapshot of snapshots) {
        handleWsPayload?.(snapshot);
      }
    };

    const applyIdleBootstrapHistory = (): void => {
      bootstrapHistoryApplyScheduled = false;
      if (sequencer.isBuffering() || rt.syncInProgress) return;
      const history = selectBootstrapHistory();
      if (!history) return;
      clearDeferredBootstrapHistory();
      bootstrapHistoryExpected = false;
      finishBootstrapHistoryWait();
      bootstrapHistoryWait = null;
      clearBootstrapHistoryWatchdog();
      handleWsPayload?.(history);
      applyDeferredRuntimeSnapshots();
    };

    const scheduleIdleBootstrapHistory = (): void => {
      if (bootstrapHistoryApplyScheduled) return;
      bootstrapHistoryApplyScheduled = true;
      Promise.resolve().then(applyIdleBootstrapHistory);
    };

    const deferBootstrapHistory = (payload: Record<string, unknown>): void => {
      const seqRaw = Number(payload.seq);
      const afterRaw = Number(payload.afterSeq);
      deferredBootstrapHistory.push({
        payload,
        seq: Number.isFinite(seqRaw) && seqRaw > 0 ? Math.floor(seqRaw) : null,
        afterSeq: Number.isFinite(afterRaw) && afterRaw >= 0 ? Math.floor(afterRaw) : null,
        arrivalOrder: bootstrapHistoryArrivalOrder++,
      });
      // The first history frame releases the waiter; selecting the latest
      // candidate at the barrier below prevents a later sibling/bootstrap
      // frame from overwriting it with an older snapshot.
      finishBootstrapHistoryWait();
      if (!sequencer.isBuffering() && !rt.syncInProgress) scheduleIdleBootstrapHistory();
    };

    const clearBootstrapHistoryWatchdog = (): void => {
      if (bootstrapHistoryWatchdogTimer === null) return;
      try {
        clearTimeout(bootstrapHistoryWatchdogTimer);
      } catch {
        // ignore
      }
      bootstrapHistoryWatchdogTimer = null;
    };

    const armBootstrapHistoryWatchdog = (): void => {
      clearBootstrapHistoryWatchdog();
      bootstrapHistoryWatchdogTimer = window.setTimeout(() => {
        bootstrapHistoryWatchdogTimer = null;
        if (!isCurrentSync()) return;

        if (bootstrapHistoryExpected) {
          bootstrapHistoryExpected = false;
          finishBootstrapHistoryWait();
        }

        if (!rt.awaitingBootstrapHistory && !rt.inputLocked.value) return;
        if (rt.busy.value || rt.turnInFlight || rt.resumeReplacePending) return;

        rt.awaitingBootstrapHistory = false;
        rt.inputLocked.value = false;
        if (rt.laneStatus.value?.kind === "progress") {
          rt.laneStatus.value = null;
        }
        void flushQueuedPrompts(rt);
      }, BOOTSTRAP_HISTORY_WATCHDOG_MS);
    };

    const waitForBootstrapHistory = async (): Promise<void> => {
      if (!bootstrapHistoryExpected || !bootstrapHistoryWait) return;
      await bootstrapHistoryWait;
    };

    const switchSyncChatLane = (chatSessionId: string): boolean => {
      const nextChatSessionId = String(chatSessionId ?? "").trim() || "main";
      if (nextChatSessionId === syncChatSessionId) return false;

      syncLaneEpoch += 1;
      syncChatSessionId = nextChatSessionId;
      clearSyncRetryTimer();
      syncRetryAttempts = 0;
      sequencer.abortCatchUp();
      sequencer = createChatSequencer(syncChatSessionId);
      clearDeferredBootstrapHistory();
      clearDeferredRuntimeSnapshots();
      bootstrapBoundarySeq = 0;
      bootstrapReportedInFlight = null;
      bootstrapHistoryExpected = false;
      finishBootstrapHistoryWait();
      bootstrapHistoryWait = null;
      clearBootstrapHistoryWatchdog();
      rt.needsChatSync = false;
      rt.syncInProgress = false;
      rt.awaitingBootstrapHistory = false;
      return true;
    };

    const resetChatSyncForGeneration = (options?: { invalidateConnection?: boolean }): void => {
      syncLaneEpoch += 1;
      sequencer.abortCatchUp();
      sequencer.resetCursor();
      clearDeferredBootstrapHistory();
      clearDeferredRuntimeSnapshots();
      bootstrapBoundarySeq = 0;
      bootstrapReportedInFlight = null;
      bootstrapHistoryExpected = false;
      finishBootstrapHistoryWait();
      bootstrapHistoryWait = null;
      clearBootstrapHistoryWatchdog();
      rt.needsChatSync = false;
      rt.syncInProgress = false;
      rt.awaitingBootstrapHistory = false;
      if (options?.invalidateConnection) {
        rt.syncGeneration += 1;
      }
    };

    const consumeSessionReset = (payload: Record<string, unknown>): boolean => {
      const effectiveChatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
      const resetScope = String(payload.scope ?? "").trim().toLowerCase() || "lane";
      const sourceChatSessionId = String(payload.sourceChatSessionId ?? "").trim();
      if (resetScope === "shared" && effectiveChatSessionId === "planner") {
        return false;
      }
      if (resetScope !== "shared" && sourceChatSessionId !== effectiveChatSessionId) {
        return false;
      }

      const laneGenerations = payload.laneGenerations;
      const generationFromMap =
        laneGenerations && typeof laneGenerations === "object" && !Array.isArray(laneGenerations)
          ? Number((laneGenerations as Record<string, unknown>)[effectiveChatSessionId])
          : Number.NaN;
      const generationValue = Number.isFinite(generationFromMap)
        ? generationFromMap
        : Number(payload.laneGeneration);
      const hasGeneration = Number.isFinite(generationValue) && generationValue >= 1;

      if (!hasGeneration) {
        if (rt.legacySessionResetConsumed) return false;
        rt.legacySessionResetConsumed = true;
      } else {
        const generation = Math.floor(generationValue);
        const scopeKey = laneGenerationScopeKey(rt, effectiveChatSessionId);
        const knownGeneration =
          rt.laneGenerationScope === scopeKey
            ? rt.laneGeneration ?? null
            : readLaneGeneration(rt, effectiveChatSessionId);
        if (knownGeneration !== null && generation < knownGeneration) {
          return false;
        }
        const duplicate =
          rt.laneGenerationScope === scopeKey && rt.lastConsumedResetGeneration === generation;
        rt.laneGeneration = generation;
        rt.laneGenerationScope = scopeKey;
        writeLaneGeneration(rt, generation, effectiveChatSessionId);
        if (duplicate) return false;
        rt.lastConsumedResetGeneration = generation;
      }

      clearOutboxForGenerationChange(rt);
      resetChatSyncForGeneration({ invalidateConnection: true });
      return true;
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
        return;
      }
      handleWsPayload?.(payload);
    };

    const applyTaskPayload = (payload: Record<string, unknown>): void => {
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
      const retryLaneEpoch = syncLaneEpoch;
      const delayMs = Math.min(15_000, 800 * Math.pow(2, Math.min(6, syncRetryAttempts)));
      syncRetryAttempts += 1;
      syncRetryTimer = window.setTimeout(() => {
        syncRetryTimer = null;
        if (!isCurrentSync(retryLaneEpoch) || !rt.needsChatSync) return;
        void syncChatEvents();
      }, delayMs);
    };

    const clearTaskSyncRetryTimer = (): void => {
      if (taskSyncRetryTimer === null) return;
      try {
        clearTimeout(taskSyncRetryTimer);
      } catch {
        // ignore
      }
      taskSyncRetryTimer = null;
    };

    const scheduleTaskSyncRetry = (): void => {
      if (!isCurrentSync() || taskSyncRetryTimer !== null || !needsTaskEventSync) return;
      const delayMs = Math.min(15_000, 800 * Math.pow(2, Math.min(6, taskSyncRetryAttempts)));
      taskSyncRetryAttempts += 1;
      taskSyncRetryTimer = window.setTimeout(() => {
        taskSyncRetryTimer = null;
        if (!isCurrentSync() || !needsTaskEventSync) return;
        void syncTaskEvents();
      }, delayMs);
    };

    async function syncChatEvents(): Promise<void> {
      const operationLaneEpoch = syncLaneEpoch;
      const activeSequencer = sequencer;
      if (rt.syncInProgress || !isCurrentSync(operationLaneEpoch)) return;
      const path = syncEventsPath(rt, project, activeSequencer.getLastAppliedSeq(), "chat", syncChatSessionId);
      if (!path) return;
      activeSequencer.beginCatchUp();
      rt.syncInProgress = true;
      try {
        let completed = false;
        const catchUpStartSeq = activeSequencer.getLastAppliedSeq();
        let afterSeq = catchUpStartSeq;
        const catchUpPayloads: Record<string, unknown>[] = [];
        for (let page = 0; page < 20; page++) {
          const pagePath = syncEventsPath(rt, project, afterSeq, "chat", syncChatSessionId);
          if (!pagePath) throw new Error("Sync path is unavailable");
          const response = await api.get<Partial<SyncEventsResponse>>(pagePath);
          if (!isCurrentSync(operationLaneEpoch)) return;
          if (response.truncated) {
            await waitForBootstrapHistory();
            if (!isCurrentSync(operationLaneEpoch)) return;
            const latestSeq = Number(response.latestSeq);
            const snapshot = response.snapshot;
            activeSequencer.replaceWithSnapshot(
              Number.isFinite(latestSeq) && latestSeq > 0 ? Math.floor(latestSeq) : 0,
              () => {
                clearStepLive(rt);
                finalizeCommandBlock(rt);
                setMessages([], rt);
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
            clearDeferredBootstrapHistory();
            applyDeferredRuntimeSnapshots();
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
        if (!isCurrentSync(operationLaneEpoch)) return;
        rt.needsChatSync = false;
        const bootstrapHistory = selectBootstrapHistory();
        clearDeferredBootstrapHistory();
        bootstrapHistoryExpected = false;
        bootstrapHistoryWait = null;
        clearBootstrapHistoryWatchdog();
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
          activeSequencer.applyCatchUp(payload, () => {
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
        activeSequencer.completeCatchUp();
        // Bootstrap snapshots are current-state rows rather than another
        // history stream. Apply them only after the baseline and all cursor
        // events have committed, so a stale snapshot cannot overwrite a newer
        // live update.
        applyDeferredRuntimeSnapshots();
        syncRetryAttempts = 0;
        clearSyncRetryTimer();
        if (shouldSyncTasks && rt.needsTaskResync) {
          rt.needsTaskResync = false;
          void deps.syncProjectState?.(pid).catch(() => {
            rt.needsTaskResync = true;
          });
        }
      } catch {
        if (isCurrentSync(operationLaneEpoch)) {
          // Keep barrier-tagged live frames queued for the retry. Dropping them
          // here loses transient deltas that have no individual replay row;
          // the retry will first fetch the missing cursor range and then
          // release the preserved frames in order.
          activeSequencer.abortCatchUp({ preserveLive: true });
          rt.needsChatSync = true;
          scheduleSyncRetry();
        }
      } finally {
        if (isCurrentSync(operationLaneEpoch)) {
          rt.syncInProgress = false;
        }
      }
    }

    async function syncTaskEvents(): Promise<void> {
      if (taskSyncInProgress || !isCurrentSync()) return;
      const path = syncEventsPath(rt, project, taskSequencer.getLastAppliedSeq(), "tasks");
      if (!path) return;
      taskSyncInProgress = true;
      taskSequencer.beginCatchUp();
      try {
        let completed = false;
        let truncated = false;
        let afterSeq = taskSequencer.getLastAppliedSeq();
        const catchUpPayloads: Record<string, unknown>[] = [];
        for (let page = 0; page < 20; page += 1) {
          const pagePath = syncEventsPath(rt, project, afterSeq, "tasks");
          if (!pagePath) throw new Error("Task sync path is unavailable");
          const response = await api.get<Partial<SyncEventsResponse>>(pagePath);
          if (!isCurrentSync()) return;
          if (response.truncated) {
            const latestSeq = Number(response.latestSeq);
            taskSequencer.replaceWithSnapshot(
              Number.isFinite(latestSeq) && latestSeq > 0 ? Math.floor(latestSeq) : 0,
              () => {},
            );
            truncated = true;
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
          if (events.length === 0) throw new Error("Task sync response hasMore without events");
        }
        if (!completed) throw new Error("Task sync catch-up exceeded page limit");
        for (const payload of catchUpPayloads) {
          taskSequencer.applyCatchUp(payload, () => applyTaskPayload(payload));
        }
        taskSequencer.completeCatchUp();
        needsTaskEventSync = false;
        taskSyncRetryAttempts = 0;
        clearTaskSyncRetryTimer();
        if (truncated && shouldSyncTasks) {
          rt.needsTaskResync = false;
          await deps.syncProjectState?.(pid);
        }
      } catch {
        // Do not commit live events buffered during a failed request. Their
        // cursor may be ahead of older offline events that the retry still
        // needs to fetch.
        taskSequencer.abortCatchUp();
        needsTaskEventSync = true;
        if (shouldSyncTasks) rt.needsTaskResync = true;
        scheduleTaskSyncRetry();
      } finally {
        taskSyncInProgress = false;
      }
    }

    const dropReconnectBusyMessage = () => {
      const items = rt.messages.value;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (item.role === "system" && item.kind === "text" && isReconnectNotice(String(item.content ?? ""))) {
          setMessages([...items.slice(0, i), ...items.slice(i + 1)], rt);
          return;
        }
      }
    };

    const cleanupTerminalCloseState = () => {
      clearReconnectTimer(rt);
      clearBootstrapHistoryWatchdog();
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
      clearTaskSyncRetryTimer();
      clearBootstrapHistoryWatchdog();
      finishBootstrapHistoryWait();
      clearStepLive(rt);
      applyStreamingDisconnectCleanup(rt);
      // Keep command previews across a transport disconnect. They are runtime
      // state and the coalesced command snapshot will reconcile them after the
      // next connection; clearing them here loses the old block before that
      // reconciliation can happen.
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
      clearBootstrapHistoryWatchdog();
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
        taskSequencer.observe(sequencedPayload, () => deps.onTaskEvent(payload, rt));
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
      consumeSessionReset,
      clearStepLive,
      sealActiveStreamingAssistant,
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
      upsertThoughtDelta: ctx.upsertThoughtDelta,
      upsertStreamingDelta,
      replaceStreamingText,
    });
    handleWsPayload = handleMessage;

    wsInstance.onMessage = (msg) => {
      if (rt.ws !== wsInstance) return;
      if (msg && typeof msg === "object" && !Array.isArray(msg)) {
        const rec = msg as Record<string, unknown>;
        const seq = Number(rec.seq);
        if (rec.type === "history" && !(Number.isFinite(seq) && seq > 0)) {
          deferBootstrapHistory(rec);
          return;
        }
        if (
          rec.bootstrap === true &&
          (rec.type === "delta_snapshot" || rec.type === "command_snapshot")
        ) {
          deferredRuntimeSnapshots.push(rec);
          if (!sequencer.isBuffering() && !rt.syncInProgress) {
            if (deferredBootstrapHistory.length > 0) scheduleIdleBootstrapHistory();
            else applyDeferredRuntimeSnapshots();
          }
          return;
        }
        if (
          mode === "worker" &&
          (rec.type === "goal:status" || rec.type === "goal:cleared")
        ) {
          taskSequencer.observe(rec, () => applyTaskPayload(rec));
          return;
        }
      }
      if (msg && typeof msg === "object" && !Array.isArray(msg)) {
        const rec = msg as Record<string, unknown>;
        const latestSeq = Number(rec.latestSeq);
        if (rec.type === "welcome") {
          const serverChatSessionId = String(rec.chatSessionId ?? "").trim();
          if (serverChatSessionId) {
            switchSyncChatLane(serverChatSessionId);
          }
          const serverLaneGeneration = Number(rec.laneGeneration);
          const hasServerLaneGeneration = Number.isFinite(serverLaneGeneration) && serverLaneGeneration >= 1;
          const welcomeChatSessionId = serverChatSessionId || syncChatSessionId;
          const welcomeLaneGenerationScope = laneGenerationScopeKey(rt, welcomeChatSessionId);
          const runtimeLaneGeneration =
            rt.laneGenerationScope === welcomeLaneGenerationScope ? rt.laneGeneration ?? null : null;
          const previousLaneGeneration = hasServerLaneGeneration
            ? runtimeLaneGeneration ?? readLaneGeneration(rt, welcomeChatSessionId)
            : null;
          if (
            hasServerLaneGeneration &&
            previousLaneGeneration !== null &&
            Math.floor(serverLaneGeneration) < previousLaneGeneration
          ) {
            try {
              wsInstance.close();
            } catch {
              // ignore
            }
            return;
          }
          const generationChanged =
            hasServerLaneGeneration &&
            previousLaneGeneration !== null &&
            previousLaneGeneration !== Math.floor(serverLaneGeneration);
          if (hasServerLaneGeneration) {
            rt.laneGeneration = Math.floor(serverLaneGeneration);
            rt.laneGenerationScope = welcomeLaneGenerationScope;
            writeLaneGeneration(rt, rt.laneGeneration, welcomeChatSessionId);
          }
          if (generationChanged) {
            clearOutboxForGenerationChange(rt);
            resetChatSyncForGeneration();
            rt.lastConsumedResetGeneration = Math.floor(serverLaneGeneration);
            const welcomeRecord = rec as Record<string, unknown> & { reset?: boolean };
            welcomeRecord.reset = true;
          }
          if (typeof rec.inFlight === "boolean") {
            bootstrapReportedInFlight = rec.inFlight;
          }
          if (Number.isFinite(latestSeq) && latestSeq > 0) {
            bootstrapBoundarySeq = Math.floor(latestSeq);
          }
          if (rec.bootstrapHistory === true) expectBootstrapHistory();
          const taskLatestSeq = Number(rec.taskLatestSeq);
          if (
            shouldSyncTasks &&
            Number.isFinite(taskLatestSeq) &&
            taskLatestSeq > taskSequencer.getLastAppliedSeq()
          ) {
            needsTaskEventSync = true;
            void syncTaskEvents();
          }
          if (Number.isFinite(latestSeq) && latestSeq > sequencer.getLastAppliedSeq()) {
            rt.needsChatSync = true;
            sequencer.beginCatchUp();
            void syncChatEvents();
          } else {
            rt.needsChatSync = false;
            // With no cursor gap the history frame is still the baseline for
            // runtime snapshots sent in the same bootstrap. Apply it through
            // the deferred path instead of letting a later generic observer
            // race the snapshot.
            if (rec.bootstrapHistory !== true) {
              scheduleIdleBootstrapHistory();
            }
          }
          // `welcome` establishes the cursor boundary and must not be queued
          // as an ordinary unsequenced live frame. Queueing it after
          // beginCatchUp caused duplicate handling and stale barriers.
          // The message handler owns thread/model/session state updates for
          // welcome. Invoke it exactly once, outside the sequencer, after the
          // cursor boundary has been established.
          handleMessage(msg);
          // `handleMessage` derives `awaitingBootstrapHistory` from the
          // welcome context and queued prompts, so arm the watchdog only after
          // that state has been updated.
          if (
            rec.bootstrapHistory === true ||
            rt.awaitingBootstrapHistory ||
            rt.inputLocked.value
          ) {
            armBootstrapHistoryWatchdog();
          }
          return;
        }
      }
      sequencer.observe(msg, () => handleMessage(msg));
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

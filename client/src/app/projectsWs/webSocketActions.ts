import { AdsWebSocket } from "../../api/ws";
import {
  buildModelIdStorageKey,
  buildReasoningEffortStorageKey,
  normalizeModelId,
  normalizeReasoningEffort,
} from "../../lib/chatPreferences";

import type { AppContext, PathValidateResponse, ProjectRuntime, ProjectTab } from "../controller";
import type { ChatActions } from "../chat";

import type { WsDeps } from "./types";
import { createWsMessageHandler } from "./wsMessage";

export function createWebSocketActions(ctx: AppContext & ChatActions, deps: WsDeps) {
  const reconnectBusyMessage = "Connection lost while a request was running. Reconnecting and syncing history…";

  const {
    api,
    loggedIn,
    projects,
    activeProjectId,
    pendingSwitchProjectId,
    runtimeByProjectId,
    plannerRuntimeByProjectId,
    reviewerRuntimeByProjectId,
    normalizeProjectId,
    getRuntime,
    getPlannerRuntime,
    getReviewerRuntime,
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
    ingestExploredActivity,
    upsertLiveActivity,
    clearPendingPrompt,
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

  const closeRuntimeConnection = (rt: { reconnectTimer: number | null; ws: { close: () => void } | null; connected: { value: boolean } }): void => {
    clearReconnectTimer(rt);
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
    for (const rt of reviewerRuntimeByProjectId.values()) {
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
      const reviewerRt = reviewerRuntimeByProjectId.get(oldKey);
      if (reviewerRt) {
        if (!reviewerRuntimeByProjectId.has(nextKey)) {
          reviewerRuntimeByProjectId.set(nextKey, reviewerRt);
        }
        reviewerRuntimeByProjectId.delete(oldKey);
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

  type WsMode = "worker" | "planner" | "reviewer";

  const resolveChatSessionId = (project: ProjectTab, mode: WsMode): string => {
    if (mode === "planner") {
      return "planner";
    }
    if (mode === "reviewer") {
      return "reviewer";
    }
    return String(project.chatSessionId ?? "").trim() || "main";
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
      const connectFn = mode === "planner" ? connectPlannerWs : mode === "reviewer" ? connectReviewerWs : connectWs;
      void connectFn(projectId).catch(() => {
        scheduleReconnect(mode, projectId, rt, "connect failed");
      });
    }, delayMs);
  };

  const getRuntimeForMode = (mode: WsMode, pid: string): ProjectRuntime => {
    if (mode === "planner") {
      return getPlannerRuntime(pid);
    }
    if (mode === "reviewer") {
      return getReviewerRuntime(pid);
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
    rt.projectSessionId = String(project.sessionId ?? "").trim();
    rt.chatSessionId = chatSessionId;
    restoreReasoningEffort(rt);
    restoreModelId(rt);

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
    let disconnectCleanupDone = false;
    let disconnectWasBusy = false;
    const shouldSyncTasks = mode === "worker";

    const dropReconnectBusyMessage = () => {
      const items = rt.messages.value;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]!;
        if (item.role === "system" && item.kind === "text" && item.content === reconnectBusyMessage) {
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
      rt.delegationsInFlight.value = [];
      dropReconnectBusyMessage();
    };

    const cleanupDisconnectState = (options?: { showReconnectMessage?: boolean }) => {
      const showReconnectMessage = options?.showReconnectMessage ?? true;
      if (disconnectCleanupDone) return;
      disconnectCleanupDone = true;
      disconnectWasBusy = rt.busy.value;
      rt.needsTaskResync = true;
      rt.connected.value = false;
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      applyStreamingDisconnectCleanup(rt);
      if (disconnectWasBusy && showReconnectMessage) {
        pushMessageBeforeLive(
          {
            role: "system",
            kind: "text",
            content: reconnectBusyMessage,
          },
          rt,
        );
      }
    };

    wsInstance.onOpen = () => {
      if (rt.ws !== wsInstance) return;
      rt.connected.value = true;
      rt.wsError.value = null;
      rt.reconnectAttempts = 0;
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
        deps.onTaskEvent(payload, rt);
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
    });

    wsInstance.onMessage = (msg) => {
      if (rt.ws !== wsInstance) return;
      handleMessage(msg);
    };

    wsInstance.connect();
  };

  const connectWs = async (projectId: string = activeProjectId.value): Promise<void> =>
    connectWsInternal("worker", projectId);

  const connectPlannerWs = async (projectId: string = activeProjectId.value): Promise<void> =>
    connectWsInternal("planner", projectId);

  const connectReviewerWs = async (projectId: string = activeProjectId.value): Promise<void> =>
    connectWsInternal("reviewer", projectId);

  return {
    clearReconnectTimer,
    closeRuntimeConnection,
    closeAllConnections,
    connectWs,
    connectPlannerWs,
    connectReviewerWs,
  };
}

import { AdsWebSocket } from "../../api/ws";

import type { AppContext, PathValidateResponse, ProjectTab } from "../controller";
import type { ChatActions } from "../chat";

import type { WsDeps } from "./types";
import { createWsMessageHandler } from "./wsMessage";

export function createWebSocketActions(ctx: AppContext & ChatActions, deps: WsDeps) {
  const { api, loggedIn, projects, activeProjectId, pendingSwitchProjectId, runtimeByProjectId, normalizeProjectId, getRuntime, maxTurnCommands } =
    ctx;

  const {
    clearStepLive,
    finalizeCommandBlock,
    applyStreamingDisconnectCleanup,
    pushMessageBeforeLive,
    restorePendingPrompt,
    flushQueuedPrompts,
    applyMergedHistory,
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
    }
    deps.persistProjects();
  };

  const resolveProjectIdentity = async (project: ProjectTab): Promise<{ sessionId: string; path: string } | null> => {
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

  const scheduleReconnect = (projectId: string, rt: { reconnectTimer: number | null; reconnectAttempts: number }, reason: string): void => {
    void reason;
    if (!loggedIn.value) return;
    if (rt.reconnectTimer !== null) return;

    const attempt = Math.min(6, rt.reconnectAttempts);
    const delayMs = Math.min(15_000, 800 * Math.pow(2, attempt));
    rt.reconnectAttempts += 1;
    rt.reconnectTimer = window.setTimeout(() => {
      rt.reconnectTimer = null;
      void connectWs(projectId).catch(() => {
        scheduleReconnect(projectId, rt, "connect failed");
      });
    }, delayMs);
  };

  const connectWs = async (projectId: string = activeProjectId.value): Promise<void> => {
    if (!loggedIn.value) return;
    let pid = normalizeProjectId(projectId);
    let project = projects.value.find((p) => p.id === pid) ?? null;
    if (!project) return;

    let rt = getRuntime(pid);
    rt.projectSessionId = String(project.sessionId ?? "").trim();

    const identity = await resolveProjectIdentity(project);
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
      rt = getRuntime(pid);
      rt.projectSessionId = String(project.sessionId ?? "").trim();
    }

    clearReconnectTimer(rt);

    const prev = rt.ws as { close: () => void } | null;
    rt.ws = null;
    try {
      prev?.close();
    } catch {
      // ignore
    }

    const wsInstance = new AdsWebSocket({ sessionId: project.sessionId });
    rt.ws = wsInstance;
    let disconnectCleanupDone = false;
    let disconnectWasBusy = false;

    const cleanupDisconnectState = () => {
      if (disconnectCleanupDone) return;
      disconnectCleanupDone = true;
      disconnectWasBusy = rt.busy.value;
      rt.needsTaskResync = true;
      rt.connected.value = false;
      rt.busy.value = false;
      clearStepLive(rt as any);
      finalizeCommandBlock(rt as any);
      applyStreamingDisconnectCleanup(rt as any);
      if (disconnectWasBusy) {
        pushMessageBeforeLive(
          {
            role: "system",
            kind: "text",
            content: "Connection lost while a request was running. Reconnecting and syncing history…",
          },
          rt as any,
        );
      }
    };

    wsInstance.onOpen = () => {
      if (rt.ws !== wsInstance) return;
      rt.connected.value = true;
      rt.wsError.value = null;
      rt.reconnectAttempts = 0;
      clearReconnectTimer(rt);
      restorePendingPrompt(rt as any);
      flushQueuedPrompts(rt as any);
      if (rt.needsTaskResync) {
        rt.needsTaskResync = false;
        void deps.syncProjectState?.(pid).catch(() => {
          // Best-effort: if sync fails we still keep the connection; next reconnect will retry.
          rt.needsTaskResync = true;
        });
      }
    };

    wsInstance.onClose = (ev) => {
      if (rt.ws !== wsInstance) return;
      cleanupDisconnectState();

      if (ev.code === 4401) {
        rt.wsError.value = "Unauthorized";
        clearReconnectTimer(rt);
        return;
      }
      if (ev.code === 4409) {
        rt.wsError.value = "Max clients reached (increase ADS_WEB_MAX_CLIENTS)";
        clearReconnectTimer(rt);
        return;
      }

      const reason = String((ev as CloseEvent).reason ?? "").trim();
      rt.wsError.value = `WebSocket closed (${ev.code || "unknown"})${reason ? `: ${reason}` : ""}`;
      scheduleReconnect(pid, rt, "close");
    };

    wsInstance.onError = () => {
      if (rt.ws !== wsInstance) return;
      cleanupDisconnectState();
      rt.wsError.value = "WebSocket error";
      scheduleReconnect(pid, rt, "error");
    };

    wsInstance.onTaskEvent = (payload) => {
      if (rt.ws !== wsInstance) return;
      deps.onTaskEvent(payload, rt);
    };

    const handleMessage = createWsMessageHandler({
      projects,
      pid,
      rt,
      wsInstance,
      maxTurnCommands,
      randomId: ctx.randomId,
      updateProject: deps.updateProject,
      applyMergedHistory,
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

  return {
    clearReconnectTimer,
    closeRuntimeConnection,
    closeAllConnections,
    connectWs,
  };
}

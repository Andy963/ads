 import {
   buildModelIdStorageKey,
   buildReasoningEffortStorageKey,
   normalizeModelId,
   normalizeReasoningEffort,
 } from "../lib/chatPreferences";
 import { supportsAgentModel } from "../lib/model_agent";

 import type { ModelConfig } from "../api/types";
 import type { AppContext } from "./controller";
 import type { ChatActions } from "./chat";
 import type { IncomingImage, ProjectRuntime } from "./controller";

export type LaneDeps = {
  connectWs: (projectId?: string) => Promise<void>;
  connectPlannerWs: (projectId?: string) => Promise<void>;
};

type QueueRunningShape = { queueStatus?: { value?: { running?: boolean } } };
function isQueueRunning(rt: unknown): boolean {
  return Boolean((rt as QueueRunningShape)?.queueStatus?.value?.running);
}

function clearRuntimeNoticeTimer(rt: Pick<ProjectRuntime, "noticeTimer">): void {
   if (rt.noticeTimer === null) return;
   try {
     clearTimeout(rt.noticeTimer);
   } catch {
     // ignore
   }
   rt.noticeTimer = null;
 }

 export function createLaneActions(ctx: AppContext & ChatActions, deps: LaneDeps) {
   const {
     api,
     activeProjectId,
     activeProject,
     normalizeProjectId,
     getRuntime,
     getPlannerRuntime,
     activeRuntime,
     activePlannerRuntime,
    apiError,
    models,
    withWorkspaceQuery,
    pendingImages,
    runtimeTasksBusy,
    clearConversationForResume,
    cancelPendingResume,
    clearPendingPromptReplayState,
    threadReset,
    enqueueMainPrompt,
    enqueuePrompt,
   } = ctx;

   const setNotice = (message: string, projectId: string = activeProjectId.value): void => {
     const pid = normalizeProjectId(projectId);
     const rt = getRuntime(pid);
     rt.apiNotice.value = message;
     clearRuntimeNoticeTimer(rt);
     rt.noticeTimer = window.setTimeout(() => {
       rt.noticeTimer = null;
       rt.apiNotice.value = null;
     }, 3000);
   };

   const clearNotice = (projectId: string = activeProjectId.value): void => {
     const pid = normalizeProjectId(projectId);
     const rt = getRuntime(pid);
     rt.apiNotice.value = null;
     clearRuntimeNoticeTimer(rt);
   };

   const resolveStorageSessionId = (rt: ProjectRuntime): string => {
     const projectSessionId = String(rt.projectSessionId ?? "").trim();
     if (projectSessionId) {
       return projectSessionId;
     }
     return String(activeProject.value?.sessionId ?? "").trim();
   };

   const loadModels = async (): Promise<void> => {
     models.value = await api.get<ModelConfig[]>("/api/models");

     const enabledModels = models.value.filter((m) => m.isEnabled);
     if (enabledModels.length === 0) return;

     const ensureRuntimeModelId = (rt: ProjectRuntime): void => {
       const sessionId = resolveStorageSessionId(rt);
       if (!sessionId) return;
       const agentId = String(rt.activeAgentId.value ?? "").trim();
       const compatibleModels = agentId
         ? enabledModels.filter((model) => supportsAgentModel({ agentId, model }))
         : enabledModels;
       const compatibleIds = new Set(
         compatibleModels.map((model) => String(model.modelId ?? model.id ?? "").trim()).filter(Boolean),
       );
       const knownIds = new Set(
         enabledModels.map((model) => String(model.modelId ?? model.id ?? "").trim()).filter(Boolean),
       );
       const fallback = compatibleModels.find((model) => model.isDefault) ?? compatibleModels[0] ?? null;
       const fallbackModelId = String(fallback?.modelId ?? fallback?.id ?? "").trim();
       const key = buildModelIdStorageKey(sessionId, rt.chatSessionId, agentId);
       let stored: string | null = null;
       try {
         stored = localStorage.getItem(key);
       } catch {
         // ignore
       }

       const storedModelId = stored === null ? null : normalizeModelId(stored);
       let candidate = storedModelId ?? normalizeModelId(rt.modelId.value);
       if (candidate === "auto" || (knownIds.has(candidate) && !compatibleIds.has(candidate))) {
         candidate = fallbackModelId || "auto";
       }

       rt.modelId.value = candidate;
       if (candidate !== "auto" && storedModelId !== candidate) {
         try {
           localStorage.setItem(key, candidate);
         } catch {
           // ignore
         }
       }
     };

     ensureRuntimeModelId(activeRuntime.value);
     ensureRuntimeModelId(activePlannerRuntime.value);
   };

   const sendMainPrompt = (content: string): void => {
     apiError.value = null;
     const text = String(content ?? "");
     const images = pendingImages.value.slice();
     pendingImages.value = [];
     if (text.trim().toLowerCase() === "/clear") {
       clearActiveChat();
       return;
     }
     enqueueMainPrompt(text, images);
   };

   const sendPlannerPrompt = (content: string): void => {
     apiError.value = null;
     const text = String(content ?? "");
     const planner = activePlannerRuntime.value;
     const images = planner.pendingImages.value.slice();
     planner.pendingImages.value = [];
     if (text.trim().toLowerCase() === "/clear") {
       clearPlannerChat();
       return;
     }
     enqueuePrompt(text, images, planner);
   };

   const persistReasoningEffort = (rt: ProjectRuntime): void => {
     const sessionId = resolveStorageSessionId(rt);
     if (!sessionId) return;
     const key = buildReasoningEffortStorageKey(sessionId, rt.chatSessionId, rt.activeAgentId.value);
     const effort = normalizeReasoningEffort(rt.modelReasoningEffort.value);
     try {
       localStorage.setItem(key, effort);
     } catch {
       // ignore
     }
   };

   const persistModelId = (rt: ProjectRuntime): void => {
     const sessionId = resolveStorageSessionId(rt);
     if (!sessionId) return;
     const key = buildModelIdStorageKey(sessionId, rt.chatSessionId, rt.activeAgentId.value);
     const modelId = normalizeModelId(rt.modelId.value);
     try {
       localStorage.setItem(key, modelId);
     } catch {
       // ignore
     }
   };

   const setMainModelReasoningEffort = (effort: string): void => {
     apiError.value = null;
     const rt = activeRuntime.value;
     rt.modelReasoningEffort.value = normalizeReasoningEffort(effort);
     persistReasoningEffort(rt);
   };

   const setMainModelId = (modelId: string): void => {
     apiError.value = null;
     const rt = activeRuntime.value;
     rt.modelId.value = normalizeModelId(modelId);
     persistModelId(rt);
   };

   const setPlannerModelReasoningEffort = (effort: string): void => {
     apiError.value = null;
     const rt = activePlannerRuntime.value;
     rt.modelReasoningEffort.value = normalizeReasoningEffort(effort);
     persistReasoningEffort(rt);
   };

   const setPlannerModelId = (modelId: string): void => {
     apiError.value = null;
     const rt = activePlannerRuntime.value;
     rt.modelId.value = normalizeModelId(modelId);
     persistModelId(rt);
   };

   const alignRuntimeModelForAgent = (rt: ProjectRuntime, agentId: string): void => {
     const nextAgentId = String(agentId ?? "").trim();
     if (!nextAgentId) return;
     const sessionId = resolveStorageSessionId(rt);
     if (sessionId) {
       try {
         const storedModel = localStorage.getItem(buildModelIdStorageKey(sessionId, rt.chatSessionId, nextAgentId));
         if (storedModel !== null) {
           rt.modelId.value = normalizeModelId(storedModel);
         }
         const storedEffort = localStorage.getItem(
           buildReasoningEffortStorageKey(sessionId, rt.chatSessionId, nextAgentId),
         );
         if (storedEffort !== null) {
           rt.modelReasoningEffort.value = normalizeReasoningEffort(storedEffort);
         }
       } catch {
         // ignore
       }
     }
     const current = normalizeModelId(rt.modelId.value);
     if (current === "auto") return;
     const enabledModels = models.value.filter((model) => model.isEnabled);
     const currentModel = enabledModels.find((model) => String(model.modelId ?? model.id ?? "").trim() === current);
     if (currentModel && supportsAgentModel({ agentId: nextAgentId, model: currentModel })) {
       return;
     }
     if (!currentModel && current !== "auto") return;
     const compatibleModels = enabledModels.filter((model) => supportsAgentModel({ agentId: nextAgentId, model }));
     const fallback = compatibleModels.find((model) => model.isDefault) ?? compatibleModels[0] ?? null;
     const fallbackId = String(fallback?.modelId ?? fallback?.id ?? "").trim();
     if (!fallbackId || fallbackId === current) return;
     rt.modelId.value = normalizeModelId(fallbackId);
     if (sessionId) {
       try {
         localStorage.setItem(buildModelIdStorageKey(sessionId, rt.chatSessionId, nextAgentId), rt.modelId.value);
       } catch {
         // ignore
       }
     }
   };

   const switchMainAgent = (agentId: string): void => {
     apiError.value = null;
     const next = String(agentId ?? "").trim();
     if (!next) return;
     const rt = activeRuntime.value;
     if (!rt.availableAgents.value.some((agent) => agent.id === next && agent.ready)) return;
     rt.activeAgentId.value = next;
     alignRuntimeModelForAgent(rt, next);
     rt.ws?.send?.("set_agent", { agentId: next });
   };

   const switchPlannerAgent = (agentId: string): void => {
     apiError.value = null;
     const next = String(agentId ?? "").trim();
     if (!next) return;
     const rt = activePlannerRuntime.value;
     if (!rt.availableAgents.value.some((agent) => agent.id === next && agent.ready)) return;
     rt.activeAgentId.value = next;
     alignRuntimeModelForAgent(rt, next);
     rt.ws?.send?.("set_agent", { agentId: next });
   };

   const interruptRuntime = (rt: ProjectRuntime): void => {
     const ws = rt.ws as { interrupt?: () => boolean } | null;
     if (ws?.interrupt?.() === true) return;
     const sessionId = String(rt.projectSessionId ?? "").trim();
     if (!sessionId) return;
     const params = new URLSearchParams({
       sessionId,
       chatSessionId: String(rt.chatSessionId ?? "").trim() || "main",
     });
     void api.post(withWorkspaceQuery(`/api/runs/interrupt?${params.toString()}`)).catch(() => {
       // Best-effort: user can retry or reconnect.
     });
   };

   const interruptActive = (): void => {
     interruptRuntime(activeRuntime.value);
   };

   const interruptPlanner = (): void => {
     interruptRuntime(activePlannerRuntime.value);
   };

   const laneClearHistoryPayload = (rt: ProjectRuntime): { scope: "lane"; sourceChatSessionId: string } => ({
     scope: "lane",
     sourceChatSessionId: String(rt.chatSessionId ?? "").trim() || "main",
   });

  const clearActiveChat = (): void => {
    const rt = activeRuntime.value;
    rt.queuedPrompts.value = [];
    clearPendingPromptReplayState(rt);
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
      clearHistoryPayload: laneClearHistoryPayload(rt),
      resetThreadId: true,
      source: "user_clear_active_context",
    });
  };

  const clearPlannerChat = (): void => {
    const rt = activePlannerRuntime.value;
    rt.queuedPrompts.value = [];
    clearPendingPromptReplayState(rt);
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
      clearHistoryPayload: laneClearHistoryPayload(rt),
      resetThreadId: true,
      source: "user_clear_planner_context",
    });
  };

  const resumeTaskThread = async (
    projectId: string = activeProjectId.value,
    options?: { sessionId?: string },
  ): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.apiError.value = null;
    clearNotice(pid);

    if (runtimeTasksBusy(rt) || isQueueRunning(rt)) {
      const msg = "任务执行中，无法恢复";
      rt.apiError.value = msg;
      rt.laneStatus.value = { kind: "error", message: msg };
      return;
    }
    if (rt.inputLocked.value) {
      return;
    }

    clearConversationForResume(rt);
    setNotice("正在恢复上下文…", pid);

    try {
      if (!rt.ws || !rt.connected.value) {
        await deps.connectWs(pid);
      }
      const sessionId = options?.sessionId?.trim();
      const sent = sessionId ? rt.ws?.send("task_resume", { threadId: sessionId }) : rt.ws?.send("task_resume");
      if (sent === false) {
        throw new Error("WebSocket 尚未连接，请稍后重试");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.apiError.value = msg;
      cancelPendingResume(rt);
      rt.laneStatus.value = { kind: "error", message: `恢复上下文失败：${msg}` };
    }
  };

   const listResumableSessions = async (
     projectId: string = activeProjectId.value,
     options?: {
       search?: string;
       includeAllCwds?: boolean;
       includeNoise?: boolean;
       agentId?: string;
       cursor?: string;
     },
   ): Promise<void> => {
     const pid = normalizeProjectId(projectId);
     const rt = getRuntime(pid);
     rt.resumableSessionsBusy.value = true;
     rt.resumableSessionsError.value = null;

     try {
       if (!rt.ws || !rt.connected.value) {
         await deps.connectWs(pid);
       }
       const sent = rt.ws?.send("session_list", {
         search: options?.search,
         includeAllCwds: options?.includeAllCwds === true,
         includeNoise: options?.includeNoise === true,
         agentId: options?.agentId,
         cursor: options?.cursor,
       });
       if (sent === false) {
         throw new Error("WebSocket not connected");
       }
     } catch (error) {
       const msg = error instanceof Error ? error.message : String(error);
       rt.resumableSessionsError.value = msg;
       rt.resumableSessionsBusy.value = false;
     }
   };

  const resumePlannerThread = async (
    projectId: string = activeProjectId.value,
    options?: { sessionId?: string },
  ): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const workerRt = getRuntime(pid);
    const rt = getPlannerRuntime(pid);
    rt.apiError.value = null;
    clearNotice(pid);

    if (runtimeTasksBusy(workerRt) || isQueueRunning(workerRt)) {
      const msg = "任务执行中，无法恢复";
      rt.apiError.value = msg;
      rt.laneStatus.value = { kind: "error", message: msg };
      return;
    }
    if (rt.inputLocked.value) {
      return;
    }

    clearConversationForResume(rt);
    setNotice("正在恢复上下文…", pid);

    try {
      if (!rt.ws || !rt.connected.value) {
        await deps.connectPlannerWs(pid);
      }
      const sessionId = options?.sessionId?.trim();
      const sent = sessionId ? rt.ws?.send("task_resume", { threadId: sessionId }) : rt.ws?.send("task_resume");
      if (sent === false) {
        throw new Error("WebSocket 尚未连接，请稍后重试");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.apiError.value = msg;
      cancelPendingResume(rt);
      rt.laneStatus.value = { kind: "error", message: `恢复上下文失败：${msg}` };
    }
  };

   const addPendingImages = (images: IncomingImage[]): void => {
     pendingImages.value.push(...images);
   };

   const clearPendingImages = (): void => {
     pendingImages.value = [];
   };

   const addPlannerPendingImages = (images: IncomingImage[]): void => {
     activePlannerRuntime.value.pendingImages.value.push(...images);
   };

   const clearPlannerPendingImages = (): void => {
     activePlannerRuntime.value.pendingImages.value = [];
   };

   const removePlannerQueuedPrompt = (promptId: string): void => {
     const id = String(promptId ?? "").trim();
     if (!id) return;
     const list = activePlannerRuntime.value.queuedPrompts.value;
     activePlannerRuntime.value.queuedPrompts.value = list.filter((p) => p.id !== id);
   };

   return {
     setNotice,
     clearNotice,
     loadModels,
     sendMainPrompt,
     sendPlannerPrompt,
     switchMainAgent,
     switchPlannerAgent,
     interruptActive,
     interruptPlanner,
     clearActiveChat,
     clearPlannerChat,
     resumeTaskThread,
     listResumableSessions,
     resumePlannerThread,
     addPendingImages,
     clearPendingImages,
     addPlannerPendingImages,
     clearPlannerPendingImages,
     removePlannerQueuedPrompt,
     setMainModelReasoningEffort,
     setPlannerModelReasoningEffort,
     setMainModelId,
     setPlannerModelId,
   };
 }

 export type LaneActions = ReturnType<typeof createLaneActions>;

 import {
   normalizeModelId,
   normalizeReasoningEffort,
 } from "../lib/chatPreferences";
 import {
   readModelIdPreference,
   readReasoningEffortPreference,
   writeModelPreference,
 } from "../lib/preferencesStore";
 import { supportsAgentModel } from "../lib/model_agent";
 import { crumb } from "../lib/diagBreadcrumbs";

 import type { ModelConfig } from "../api/types";
 import type { AppContext } from "./controller";
 import type { ChatActions } from "./chat";
 import type { IncomingImage, ProjectRuntime } from "./controller";

export type LaneDeps = {
  connectWs: (projectId?: string) => Promise<void>;
  connectAdvisorWs: (projectId?: string) => Promise<void>;
};

type RuntimeWebSocket = {
  send?: (
    type: string,
    payload?: unknown,
    options?: { clientMessageId?: string },
  ) => boolean;
};

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
     getAdvisorRuntime,
     activeRuntime,
     activeAdvisorRuntime,
    apiError,
    models,
    withWorkspaceQuery,
    pendingImages,
    clearConversationForResume,
    cancelPendingResume,
    clearPendingPromptReplayState,
    threadReset,
    enqueueMainPrompt,
    enqueuePrompt,
    retryQueuedPrompt,
    randomUuid,
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
       const stored = readModelIdPreference(sessionId, rt.chatSessionId, agentId);

       const storedModelId = stored === null ? null : normalizeModelId(stored);
       let candidate = storedModelId ?? normalizeModelId(rt.modelId.value);
       if (candidate === "auto" || (knownIds.has(candidate) && !compatibleIds.has(candidate))) {
         candidate = fallbackModelId || "auto";
       }

       rt.modelId.value = candidate;
       if (candidate !== "auto" && storedModelId !== candidate) {
         writeModelPreference(sessionId, rt.chatSessionId, agentId, { modelId: candidate });
       }
     };

     ensureRuntimeModelId(activeRuntime.value);
     ensureRuntimeModelId(activeAdvisorRuntime.value);
   };

   const sendMainPrompt = (content: string): void => {
     crumb(`send:worker(${String(content ?? "").length}字)`);
     apiError.value = null;
     const worker = activeRuntime.value;
     const text = String(content ?? "");
     const images = pendingImages.value.slice();
     pendingImages.value = [];
     if (text.trim().toLowerCase() === "/clear") {
       clearActiveChat();
       worker.composerDraft.value = "";
       return;
     }
     enqueueMainPrompt(text, images);
     worker.composerDraft.value = "";
   };

   const sendAdvisorPrompt = (content: string): void => {
     crumb(`send:advisor(${String(content ?? "").length}字)`);
     apiError.value = null;
     const text = String(content ?? "");
     const advisor = activeAdvisorRuntime.value;
     const images = advisor.pendingImages.value.slice();
     advisor.pendingImages.value = [];
     if (text.trim().toLowerCase() === "/clear") {
       clearAdvisorChat();
       advisor.composerDraft.value = "";
       return;
     }
     enqueuePrompt(text, images, advisor);
     advisor.composerDraft.value = "";
   };

   const persistReasoningEffort = (rt: ProjectRuntime): void => {
     const sessionId = resolveStorageSessionId(rt);
     if (!sessionId) return;
     const effort = normalizeReasoningEffort(rt.modelReasoningEffort.value);
     writeModelPreference(sessionId, rt.chatSessionId, rt.activeAgentId.value, { effort });
   };

   const persistModelId = (rt: ProjectRuntime): void => {
     const sessionId = resolveStorageSessionId(rt);
     if (!sessionId) return;
     const modelId = normalizeModelId(rt.modelId.value);
     writeModelPreference(sessionId, rt.chatSessionId, rt.activeAgentId.value, { modelId });
   };

  const sendModelOverride = (rt: ProjectRuntime): void => {
    const model = normalizeModelId(rt.modelId.value);
    if (model === "auto") return;

    const socket = rt.ws as RuntimeWebSocket | null;
    if (!socket?.send) return;

    const effort = normalizeReasoningEffort(rt.modelReasoningEffort.value);
    const accepted = socket.send(
      "model_override",
      { model, model_reasoning_effort: effort },
      { clientMessageId: randomUuid() },
    );
    if (accepted === false) {
      rt.laneStatus.value = { kind: "error", message: "Model switch failed: the current chat connection is unavailable." };
      return;
    }
    rt.laneStatus.value = { kind: "progress", message: `Switching model: ${model}…` };
  };

   const setMainModelReasoningEffort = (effort: string): void => {
     apiError.value = null;
     const rt = activeRuntime.value;
     rt.modelReasoningEffort.value = normalizeReasoningEffort(effort);
     persistReasoningEffort(rt);
     sendModelOverride(rt);
   };

   const setMainModelId = (modelId: string): void => {
     apiError.value = null;
     const rt = activeRuntime.value;
     rt.modelId.value = normalizeModelId(modelId);
     persistModelId(rt);
     sendModelOverride(rt);
   };

   const setAdvisorModelReasoningEffort = (effort: string): void => {
     apiError.value = null;
     const rt = activeAdvisorRuntime.value;
     rt.modelReasoningEffort.value = normalizeReasoningEffort(effort);
     persistReasoningEffort(rt);
     sendModelOverride(rt);
   };

   const setAdvisorModelId = (modelId: string): void => {
     apiError.value = null;
     const rt = activeAdvisorRuntime.value;
     rt.modelId.value = normalizeModelId(modelId);
     persistModelId(rt);
     sendModelOverride(rt);
   };

   const alignRuntimeModelForAgent = (rt: ProjectRuntime, agentId: string): void => {
     const nextAgentId = String(agentId ?? "").trim();
     if (!nextAgentId) return;
     const sessionId = resolveStorageSessionId(rt);
     if (sessionId) {
       try {
         const storedModel = readModelIdPreference(sessionId, rt.chatSessionId, nextAgentId);
         if (storedModel !== null) {
           rt.modelId.value = normalizeModelId(storedModel);
         }
         const storedEffort = readReasoningEffortPreference(sessionId, rt.chatSessionId, nextAgentId);
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
       writeModelPreference(sessionId, rt.chatSessionId, nextAgentId, { modelId: rt.modelId.value });
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

   const switchAdvisorAgent = (agentId: string): void => {
     apiError.value = null;
     const next = String(agentId ?? "").trim();
     if (!next) return;
     const rt = activeAdvisorRuntime.value;
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

   const interruptAdvisor = (): void => {
     interruptRuntime(activeAdvisorRuntime.value);
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

  const clearAdvisorChat = (): void => {
    const rt = activeAdvisorRuntime.value;
    rt.queuedPrompts.value = [];
    clearPendingPromptReplayState(rt);
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
      clearHistoryPayload: laneClearHistoryPayload(rt),
      resetThreadId: true,
      source: "user_clear_advisor_context",
    });
    rt.ignoreNextHistory = false;
    rt.ignoreNextHistoryGeneration = undefined;
  };

  const startNewAdvisorSession = (): void => {
    const rt = activeAdvisorRuntime.value;
    rt.queuedPrompts.value = [];
    clearPendingPromptReplayState(rt);
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
      clearHistoryPayload: {
        ...laneClearHistoryPayload(rt),
        mode: "new_session",
      },
      resetThreadId: true,
      source: "user_new_advisor_session",
    });
    rt.ignoreNextHistory = false;
    rt.ignoreNextHistoryGeneration = undefined;
  };

  const resumeTaskThread = async (
    projectId: string = activeProjectId.value,
    options?: { sessionId?: string },
  ): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.apiError.value = null;
    clearNotice(pid);

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

  const resumeAdvisorThread = async (
    projectId: string = activeProjectId.value,
    options?: { sessionId?: string },
  ): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getAdvisorRuntime(pid);
    rt.apiError.value = null;
    clearNotice(pid);

    if (rt.inputLocked.value) {
      return;
    }

    clearConversationForResume(rt);
    setNotice("正在恢复上下文…", pid);

    try {
      if (!rt.ws || !rt.connected.value) {
        await deps.connectAdvisorWs(pid);
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

   const removePendingImage = (index: number): void => {
     if (index >= 0 && index < pendingImages.value.length) {
       pendingImages.value.splice(index, 1);
     }
   };

   const addAdvisorPendingImages = (images: IncomingImage[]): void => {
     activeAdvisorRuntime.value.pendingImages.value.push(...images);
   };

   const clearAdvisorPendingImages = (): void => {
     activeAdvisorRuntime.value.pendingImages.value = [];
   };

   const removeAdvisorPendingImage = (index: number): void => {
     const list = activeAdvisorRuntime.value.pendingImages.value;
     if (index >= 0 && index < list.length) {
       list.splice(index, 1);
     }
   };

  const removeAdvisorQueuedPrompt = (promptId: string): void => {
     const id = String(promptId ?? "").trim();
     if (!id) return;
     const list = activeAdvisorRuntime.value.queuedPrompts.value;
    activeAdvisorRuntime.value.queuedPrompts.value = list.filter((p) => p.id !== id);
  };

  const retryAdvisorQueuedPrompt = (promptId: string): void => {
    retryQueuedPrompt(promptId, activeAdvisorRuntime.value);
  };

  return {
    setNotice,
    clearNotice,
    loadModels,
    sendMainPrompt,
    sendAdvisorPrompt,
    switchMainAgent,
    switchAdvisorAgent,
    interruptActive,
    interruptAdvisor,
    clearActiveChat,
    clearAdvisorChat,
    startNewAdvisorSession,
    resumeTaskThread,
    listResumableSessions,
    resumeAdvisorThread,
    addPendingImages,
    clearPendingImages,
    removePendingImage,
    addAdvisorPendingImages,
    clearAdvisorPendingImages,
    removeAdvisorPendingImage,
    removeAdvisorQueuedPrompt,
    retryAdvisorQueuedPrompt,
    setMainModelReasoningEffort,
    setAdvisorModelReasoningEffort,
    setMainModelId,
    setAdvisorModelId,
  };
}

export type LaneActions = ReturnType<typeof createLaneActions>;

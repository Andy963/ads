import { nextTick } from "vue";

import { formatApiError, looksLikeNotFound } from "../lib/api_error";
import {
  buildModelIdStorageKey,
  buildReasoningEffortStorageKey,
  normalizeModelId,
  normalizeReasoningEffort,
} from "../lib/chatPreferences";
import { supportsAgentModel } from "../lib/model_agent";

import type { CreateTaskInput, ModelConfig, Task, TaskDetail, TaskQueueStatus } from "../api/types";
import type { AppContext } from "./controller";
import type { ChatActions } from "./chat";
import type { IncomingImage, ProjectRuntime } from "./controller";

import { createTaskEventActions } from "./tasks/events";
import { removeTaskLocal } from "./tasks/localState";
import { createNoticeActions } from "./tasks/notice";
import { createTaskReorderActions } from "./tasks/reorder";
import { createTaskRunHelpers } from "./tasks/runHelpers";
import { pickNextSelectedTaskId } from "./tasks/selection";

export type TaskDeps = {
  connectWs: (projectId?: string) => Promise<void>;
  connectPlannerWs: (projectId?: string) => Promise<void>;
};

export type LoadTasksOptions = {
  status?: Task["status"];
  limit?: number;
  preserveSelection?: boolean;
  skipIfTasksNonEmpty?: boolean;
};

export function createTaskActions(ctx: AppContext & ChatActions, deps: TaskDeps) {
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
    withWorkspaceQueryFor,
    withWorkspaceQuery,
    tasks,
    selectedId,
    apiAuthorized,
    pendingDeleteProjectId,
    pendingDeleteTaskId,
    deleteConfirmOpen,
    deleteConfirmButtonEl,
    taskCreateDialogOpen,
    pendingImages,
    runtimeTasksBusy,
  } = ctx;

  const {
    threadReset,
    clearConversationForResume,
    cancelPendingResume,
    enqueueMainPrompt,
    enqueuePrompt,
    removeQueuedPrompt,
    clearPendingPromptReplayState,
  } = ctx;

  const { setNotice, clearNotice } = createNoticeActions({ activeProjectId, normalizeProjectId, getRuntime });

  const resolveStorageSessionId = (rt: ProjectRuntime): string => {
    const projectSessionId = String(rt.projectSessionId ?? "").trim();
    if (projectSessionId) {
      return projectSessionId;
    }
    return String(activeProject.value?.sessionId ?? "").trim();
  };

  const formatTaskNoticeLabel = (taskId: string, projectId: string): string => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    const title = String(rt.tasks.value.find((t) => t.id === taskId)?.title ?? "").trim();
    if (title) return `"${title}"`;
    return taskId.slice(0, 8);
  };

  const resetTaskState = (): void => {
    tasks.value = [];
    selectedId.value = null;
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
      if (candidate !== "auto" && !compatibleIds.has(candidate)) {
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

  const loadQueueStatus = async (projectId: string = activeProjectId.value): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.queueStatus.value = await api.get<TaskQueueStatus>(withWorkspaceQueryFor(pid, "/api/task-queue/status"));
  };

  const runTaskQueue = async (projectId: string = activeProjectId.value): Promise<void> => {
    apiError.value = null;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    try {
      const res = await api.post<TaskQueueStatus & { queued?: boolean }>(withWorkspaceQueryFor(pid, "/api/task-queue/run"), {});
      rt.queueStatus.value = res;
      if (res?.queued) {
        setNotice("已加入队列，等待当前任务完成…", pid);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
  };

  const pauseTaskQueue = async (projectId: string = activeProjectId.value): Promise<void> => {
    apiError.value = null;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    try {
      rt.queueStatus.value = await api.post<TaskQueueStatus>(withWorkspaceQueryFor(pid, "/api/task-queue/pause"), {});
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
  };

  const loadTasks = async (projectId: string = activeProjectId.value, options?: LoadTasksOptions): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : 100;
    const status = String(options?.status ?? "").trim();
    const base = `/api/tasks?limit=${encodeURIComponent(String(limit))}&includeArchived=1`;
    const url = status ? `${base}&status=${encodeURIComponent(status)}` : base;
    const fetched = await api.get<Task[]>(withWorkspaceQueryFor(pid, url));
    if (options?.skipIfTasksNonEmpty && rt.tasks.value.length > 0) {
      return;
    }
    rt.tasks.value = fetched;

    if (options?.preserveSelection) {
      return;
    }

    if (!rt.selectedId.value) {
      rt.selectedId.value = pickNextSelectedTaskId(rt.tasks.value);
    }
  };

  const upsertTask = (t: Task, rt?: ProjectRuntime): void => {
    const state = ctx.runtimeOrActive(rt);
    const idx = state.tasks.value.findIndex((x) => x.id === t.id);
    const normalizedAttachments = Array.isArray((t as { attachments?: unknown }).attachments)
      ? ((t as { attachments?: Task["attachments"] }).attachments ?? undefined)
      : undefined;
    if (idx >= 0) {
      const existing = state.tasks.value[idx]!;
      state.tasks.value[idx] = {
        ...existing,
        ...t,
        attachments: normalizedAttachments ?? existing.attachments,
      };
    } else {
      state.tasks.value.unshift(t);
    }
  };

  const { setTaskRunBusy, mockSingleTaskRun } = createTaskRunHelpers({
    activeProjectId,
    normalizeProjectId,
    getRuntime,
    upsertTask,
  });

  const { onTaskEvent } = createTaskEventActions(ctx, { upsertTask, removeTask: removeTaskLocal, loadQueueStatus });

  const {
    reorderPendingTasks,
    updateQueuedTask,
    updateQueuedTaskAndRun: reorderUpdateQueuedTaskAndRun,
  } = createTaskReorderActions(ctx, {
    clearNotice,
    loadTasks,
    runTaskQueue,
    upsertTask: (t) => upsertTask(t),
  });
  const updateQueuedTaskAndRun = async (id: string, updates: Record<string, unknown>): Promise<void> => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;

    const existing = tasks.value.find((t) => t.id === taskId) ?? null;
    const status = existing?.status ?? null;

    const shouldRerun = status === "completed" || status === "failed";
    if (shouldRerun) {
      apiError.value = null;
      clearNotice();
      try {
        const res = await api.post<{ success: boolean; task?: Task; sourceTaskId?: string }>(withWorkspaceQuery(`/api/tasks/${taskId}/rerun`), updates);
        if (res?.task) {
          upsertTask(res.task);
          selectedId.value = res.task.id;
          await runSingleTask(res.task.id);
        } else {
          await loadTasks();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        apiError.value = msg;
      }
      return;
    }

    const shouldUseSingleRun = status === "cancelled";
    if (!shouldUseSingleRun) {
      await reorderUpdateQueuedTaskAndRun(taskId, updates);
      return;
    }

    await updateQueuedTask(taskId, updates);
    if (apiError.value) {
      return;
    }
    await runSingleTask(taskId);
  };

  const refreshTaskRow = async (id: string, projectId: string = activeProjectId.value): Promise<void> => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    try {
      const detail = await api.get<TaskDetail>(withWorkspaceQueryFor(pid, `/api/tasks/${taskId}`));
      upsertTask(detail, rt);
    } catch {
      // ignore
    }
  };

  const createTask = async (input: CreateTaskInput): Promise<Task | null> => {
    apiError.value = null;
    clearNotice();
    try {
      const created = await api.post<Task>(withWorkspaceQuery("/api/tasks"), input);
      upsertTask(created);
      selectedId.value = created.id;
      return created;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
    return null;
  };

  const submitTaskCreate = async (input: CreateTaskInput): Promise<void> => {
    // Close the modal immediately so the UI feels responsive (network calls can take a while).
    taskCreateDialogOpen.value = false;
    await createTask(input);
  };

  const submitTaskCreateAndRun = async (input: CreateTaskInput): Promise<void> => {
    // Close the modal immediately so the UI feels responsive (network calls can take a while).
    taskCreateDialogOpen.value = false;
    const created = await createTask(input);
    if (!created) return;
    await runTaskQueue();
  };

  const runSingleTask = async (id: string, projectId: string = activeProjectId.value): Promise<void> => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    const label = formatTaskNoticeLabel(taskId, pid);

    rt.apiError.value = null;
    clearNotice(pid);
    if (!apiAuthorized.value) {
      rt.apiError.value = "Unauthorized";
      return;
    }
    if (rt.runBusyIds.value.has(taskId)) {
      return;
    }

    setTaskRunBusy(taskId, true, pid);
    try {
      const res = await api.post<{ success: boolean; queued?: boolean; taskId?: string; state?: string; mode?: string }>(
        withWorkspaceQueryFor(pid, `/api/tasks/${taskId}/run`),
        {},
      );
      void res;
      if (res?.queued) {
        setNotice(`Task ${label} queued`, pid);
      } else {
        setNotice(`Task ${label} scheduled`, pid);
      }
      await refreshTaskRow(taskId, pid);
      await loadQueueStatus(pid);
    } catch (error) {
      const msg = formatApiError(error);
      if (import.meta.env.DEV && looksLikeNotFound(msg)) {
        setNotice(`Task ${label} scheduled (mock)`, pid);
        mockSingleTaskRun(taskId, pid);
        return;
      }
      rt.apiError.value = msg;
    } finally {
      setTaskRunBusy(taskId, false, pid);
    }
  };

  const cancelTask = async (id: string): Promise<void> => {
    apiError.value = null;
    clearNotice();
    try {
      const res = await api.patch<{ success: boolean; task?: Task | null }>(withWorkspaceQuery(`/api/tasks/${id}`), {
        action: "cancel",
      });
      if (res?.task) {
        upsertTask(res.task);
      }
      await loadTasks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
  };

  const retryTask = async (id: string): Promise<void> => {
    apiError.value = null;
    clearNotice();
    try {
      const res = await api.post<{ success: boolean; task?: Task | null }>(withWorkspaceQuery(`/api/tasks/${id}/retry`), {});
      if (res?.task) {
        upsertTask(res.task);
      }
      await loadTasks();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
  };

  const deleteTask = async (id: string): Promise<void> => {
    apiError.value = null;
    clearNotice();
    const taskId = String(id ?? "").trim();
    if (!taskId) return;
    const pid = normalizeProjectId(activeProjectId.value);
    const rt = getRuntime(pid);
    const t = rt.tasks.value.find((x) => x.id === taskId);
    if (t && (t.status === "running" || t.status === "planning")) {
      apiError.value = "任务执行中，无法删除（请先终止）";
      return;
    }
    pendingDeleteProjectId.value = pid;
    pendingDeleteTaskId.value = taskId;
    deleteConfirmOpen.value = true;
    void nextTick(() => deleteConfirmButtonEl.value?.focus());
  };

  const cancelDeleteTask = (): void => {
    deleteConfirmOpen.value = false;
    pendingDeleteProjectId.value = null;
    pendingDeleteTaskId.value = null;
  };

  const confirmDeleteTask = async (): Promise<void> => {
    const taskId = pendingDeleteTaskId.value;
    const projectId = pendingDeleteProjectId.value ?? activeProjectId.value;
    deleteConfirmOpen.value = false;
    pendingDeleteProjectId.value = null;
    pendingDeleteTaskId.value = null;
    if (!taskId) return;

    apiError.value = null;
    try {
      const pid = normalizeProjectId(projectId);
      const rt = getRuntime(pid);
      await api.delete<{ success: boolean }>(withWorkspaceQueryFor(pid, `/api/tasks/${taskId}`));
      removeTaskLocal(taskId, rt);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
  };

  const sendMainPrompt = (content: string): void => {
    apiError.value = null;
    if (activeRuntime.value.inputLocked.value) return;
    const text = String(content ?? "");
    const images = pendingImages.value.slice();
    pendingImages.value = [];
    enqueueMainPrompt(text, images);
  };

  const sendPlannerPrompt = (content: string): void => {
    apiError.value = null;
    const text = String(content ?? "");
    const planner = activePlannerRuntime.value;
    if (planner.inputLocked.value) return;
    const images = planner.pendingImages.value.slice();
    planner.pendingImages.value = [];
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

  /**
   * Stop an in-flight run.
   *
   * The WebSocket frame is the fast path but only works while the socket is open —
   * precisely not the case when a connection dropped mid-turn and left the run
   * going. When the frame cannot be sent, fall back to the HTTP route, which
   * reaches the same abort registry.
   */
  const interruptRuntime = (rt: ProjectRuntime): void => {
    const activeTask = rt.tasks.value.find((task) => task.status === "planning" || task.status === "running");
    if (activeTask) {
      void cancelTask(activeTask.id);
      return;
    }

    const ws = rt.ws as { interrupt?: () => boolean } | null;
    if (ws?.interrupt?.() === true) return;
    const sessionId = String(rt.projectSessionId ?? "").trim();
    if (!sessionId) return;
    const params = new URLSearchParams({
      sessionId,
      chatSessionId: String(rt.chatSessionId ?? "").trim() || "main",
    });
    void api.post(withWorkspaceQuery(`/api/runs/interrupt?${params.toString()}`)).catch(() => {
      // Best-effort: the user can retry, and a reconnect re-syncs the real state.
    });
  };

  const interruptActive = (): void => {
    interruptRuntime(activeRuntime.value);
  };

  const interruptPlanner = (): void => {
    interruptRuntime(activePlannerRuntime.value);
  };

  const clearActiveChat = (): void => {
    const rt = activeRuntime.value;
    rt.composerDraft.value = "";
    rt.queuedPrompts.value = [];
    clearPendingPromptReplayState(rt);
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
      resetThreadId: true,
      source: "user_reset_thread",
    });
  };

  const clearPlannerChat = (): void => {
    const rt = activePlannerRuntime.value;
    rt.composerDraft.value = "";
    rt.queuedPrompts.value = [];
    clearPendingPromptReplayState(rt);
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
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

    if (runtimeTasksBusy(rt) || Boolean(rt.queueStatus.value?.running)) {
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
      // Keep the no-selection call shape identical to the original one-click resume.
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

  /**
   * Ask the backend for resumable sessions. Read-only, so it is safe to call
   * whenever the picker opens; results land on the runtime via
   * `session_list_result`.
   */
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
        throw new Error("WebSocket 尚未连接，请稍后重试");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.resumableSessionsBusy.value = false;
      rt.resumableSessionsError.value = msg;
    }
  };

  const resumePlannerThread = async (projectId: string = activeProjectId.value): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const workerRt = getRuntime(pid);
    const rt = getPlannerRuntime(pid);
    rt.apiError.value = null;

    if (rt.busy.value || runtimeTasksBusy(workerRt) || Boolean(workerRt.queueStatus.value?.running)) {
      const msg = "任务执行中，无法恢复";
      rt.apiError.value = msg;
      rt.laneStatus.value = { kind: "error", message: msg };
      return;
    }
    if (rt.inputLocked.value) {
      return;
    }

    clearConversationForResume(rt);

    try {
      if (!rt.ws || !rt.connected.value) {
        await deps.connectPlannerWs(pid);
      }
      const sent = rt.ws?.send("task_resume");
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

  const addPendingImages = (imgs: IncomingImage[]): void => {
    const rt = activeRuntime.value;
    if (rt.inputLocked.value) return;
    rt.pendingImages.value = [...rt.pendingImages.value, ...(Array.isArray(imgs) ? imgs : [])];
  };

  const clearPendingImages = (): void => {
    if (activeRuntime.value.inputLocked.value) return;
    activeRuntime.value.pendingImages.value = [];
  };

  const addPlannerPendingImages = (imgs: IncomingImage[]): void => {
    const rt = activePlannerRuntime.value;
    if (rt.inputLocked.value) return;
    rt.pendingImages.value = [...rt.pendingImages.value, ...(Array.isArray(imgs) ? imgs : [])];
  };

  const clearPlannerPendingImages = (): void => {
    if (activePlannerRuntime.value.inputLocked.value) return;
    activePlannerRuntime.value.pendingImages.value = [];
  };

  const removePlannerQueuedPrompt = (id: string): void => {
    removeQueuedPrompt(id, activePlannerRuntime.value);
  };

  const openTaskCreateDialog = (): void => {
    apiError.value = null;
    taskCreateDialogOpen.value = true;
  };

  const closeTaskCreateDialog = (): void => {
    taskCreateDialogOpen.value = false;
  };

  const select = (id: string): void => {
    selectedId.value = id;
  };

  return {
    setNotice,
    clearNotice,
    resetTaskState,
    loadModels,
    loadQueueStatus,
    runTaskQueue,
    pauseTaskQueue,
    reorderPendingTasks,
    loadTasks,
    upsertTask,
    onTaskEvent,
    removeTaskLocal,
    updateQueuedTask,
    updateQueuedTaskAndRun,
    refreshTaskRow,
    createTask,
    submitTaskCreate,
    submitTaskCreateAndRun,
    runSingleTask,
    cancelTask,
    retryTask,
    deleteTask,
    cancelDeleteTask,
    confirmDeleteTask,
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
    openTaskCreateDialog,
    closeTaskCreateDialog,
    select,
    removePlannerQueuedPrompt,
    setMainModelReasoningEffort,
    setPlannerModelReasoningEffort,
    setMainModelId,
    setPlannerModelId,
    goalPause: (taskId: string, projectId: string = activeProjectId.value): void => {
      const rt = getRuntime(normalizeProjectId(projectId));
      rt.ws?.send("goal:pause", { taskId });
    },
    goalResume: (taskId: string, projectId: string = activeProjectId.value): void => {
      const rt = getRuntime(normalizeProjectId(projectId));
      rt.ws?.send("goal:resume", { taskId });
    },
    goalClear: (taskId: string, projectId: string = activeProjectId.value): void => {
      const rt = getRuntime(normalizeProjectId(projectId));
      rt.ws?.send("goal:clear", { taskId });
    },
  };
}

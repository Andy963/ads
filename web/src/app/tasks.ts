import { nextTick } from "vue";

import { formatApiError, looksLikeNotFound } from "../lib/api_error";

import type { CreateTaskInput, ModelConfig, Task, TaskDetail, TaskQueueStatus } from "../api/types";
import type { AppContext } from "./controller";
import type { ChatActions } from "./chat";
import type { IncomingImage, ProjectRuntime } from "./controller";

import { createTaskEventActions } from "./tasks/events";
import { removeTaskLocal } from "./tasks/localState";
import { createNoticeActions } from "./tasks/notice";
import { createTaskReorderActions } from "./tasks/reorder";
import { createTaskRunHelpers } from "./tasks/runHelpers";

export type TaskDeps = {
  connectWs: (projectId?: string) => Promise<void>;
};

export type LoadTasksOptions = {
  status?: Task["status"];
  limit?: number;
  preserveSelection?: boolean;
};

export function createTaskActions(ctx: AppContext & ChatActions, deps: TaskDeps) {
  const {
    api,
    activeProjectId,
    normalizeProjectId,
    getRuntime,
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

  const { threadReset, clearConversationForResume, enqueueMainPrompt, enqueuePrompt, removeQueuedPrompt } = ctx;

  const { setNotice, clearNotice } = createNoticeActions({ activeProjectId, normalizeProjectId, getRuntime });

  const resetTaskState = (): void => {
    tasks.value = [];
    selectedId.value = null;
  };

  const loadModels = async (): Promise<void> => {
    models.value = await api.get<ModelConfig[]>("/api/models");
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
    const base = `/api/tasks?limit=${encodeURIComponent(String(limit))}`;
    const url = status ? `${base}&status=${encodeURIComponent(status)}` : base;
    rt.tasks.value = await api.get<Task[]>(withWorkspaceQueryFor(pid, url));

    if (options?.preserveSelection) {
      return;
    }

    if (!rt.selectedId.value && rt.tasks.value.length > 0) {
      const nextPending = rt.tasks.value
        .filter((t) => t.status === "pending")
        .slice()
        .sort((a, b) => {
          if (a.priority !== b.priority) return b.priority - a.priority;
          if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
          return a.createdAt - b.createdAt;
        })[0];
      rt.selectedId.value = (nextPending ?? rt.tasks.value[0])!.id;
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
        } else {
          await loadTasks();
        }
        await runTaskQueue();
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
        setNotice(`Task ${taskId.slice(0, 8)} queued`, pid);
      } else {
        setNotice(`Task ${taskId.slice(0, 8)} scheduled`, pid);
      }
      await refreshTaskRow(taskId, pid);
      await loadQueueStatus(pid);
    } catch (error) {
      const msg = formatApiError(error);
      if (import.meta.env.DEV && looksLikeNotFound(msg)) {
        setNotice(`Task ${taskId.slice(0, 8)} scheduled (mock)`, pid);
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
    const text = String(content ?? "");
    const images = pendingImages.value.slice();
    pendingImages.value = [];
    enqueueMainPrompt(text, images);
  };

  const sendPlannerPrompt = (content: string): void => {
    apiError.value = null;
    const text = String(content ?? "");
    const planner = activePlannerRuntime.value;
    const images = planner.pendingImages.value.slice();
    planner.pendingImages.value = [];
    enqueuePrompt(text, images, planner);
  };

  const switchMainAgent = (agentId: string): void => {
    apiError.value = null;
    const next = String(agentId ?? "").trim();
    if (!next) return;
    const rt = activeRuntime.value;
    rt.ws?.send?.("command", { command: `/agent ${next}`, silent: true });
  };

  const switchPlannerAgent = (agentId: string): void => {
    apiError.value = null;
    const next = String(agentId ?? "").trim();
    if (!next) return;
    const rt = activePlannerRuntime.value;
    rt.ws?.send?.("command", { command: `/agent ${next}`, silent: true });
  };

  const interruptActive = (): void => {
    activeRuntime.value.ws?.interrupt();
  };

  const interruptPlanner = (): void => {
    activePlannerRuntime.value.ws?.interrupt();
  };

  const clearActiveChat = (): void => {
    const rt = activeRuntime.value;
    threadReset(rt, {
      notice: "",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: true,
      resetThreadId: true,
      source: "user_reset_thread",
    });
  };

  const resumeTaskThread = async (projectId: string = activeProjectId.value): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.apiError.value = null;
    clearNotice(pid);

    if (runtimeTasksBusy(rt) || Boolean(rt.queueStatus.value?.running)) {
      rt.apiError.value = "任务执行中，无法恢复";
      return;
    }

    clearConversationForResume(rt);
    setNotice("正在恢复上下文…", pid);

    try {
      if (!rt.ws || !rt.connected.value) {
        await deps.connectWs(pid);
      }
      rt.ws?.send("task_resume");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.apiError.value = msg;
    }
  };

  const addPendingImages = (imgs: IncomingImage[]): void => {
    const rt = activeRuntime.value;
    rt.pendingImages.value = [...rt.pendingImages.value, ...(Array.isArray(imgs) ? imgs : [])];
  };

  const clearPendingImages = (): void => {
    activeRuntime.value.pendingImages.value = [];
  };

  const addPlannerPendingImages = (imgs: IncomingImage[]): void => {
    const rt = activePlannerRuntime.value;
    rt.pendingImages.value = [...rt.pendingImages.value, ...(Array.isArray(imgs) ? imgs : [])];
  };

  const clearPlannerPendingImages = (): void => {
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
    resumeTaskThread,
    addPendingImages,
    clearPendingImages,
    addPlannerPendingImages,
    clearPlannerPendingImages,
    openTaskCreateDialog,
    closeTaskCreateDialog,
    select,
    removePlannerQueuedPrompt,
  };
}

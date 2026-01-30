import { nextTick } from "vue";

import { formatApiError, looksLikeNotFound } from "../lib/api_error";

import type { CreateTaskInput, ModelConfig, PlanStep, Task, TaskDetail, TaskEventPayload, TaskQueueStatus } from "../api/types";
import type { AppContext } from "./controller";
import type { ChatActions } from "./chat";
import type { IncomingImage, ProjectRuntime } from "./controller";

export type TaskDeps = {
  connectWs: (projectId?: string) => Promise<void>;
};

export function createTaskActions(ctx: AppContext & ChatActions, deps: TaskDeps) {
  const {
    api,
    activeProjectId,
    normalizeProjectId,
    getRuntime,
    activeRuntime,
    apiError,
    models,
    withWorkspaceQueryFor,
    withWorkspaceQuery,
    tasks,
    selectedId,
    expanded,
    plansByTaskId,
    apiAuthorized,
    pendingDeleteTaskId,
    deleteConfirmOpen,
    deleteConfirmButtonEl,
    taskCreateDialogOpen,
    pendingImages,
    runtimeTasksBusy,
    randomId,
  } = ctx;

  const {
    threadReset,
    clearConversationForResume,
    finalizeCommandBlock,
    clearStepLive,
    flushQueuedPrompts,
    enqueueMainPrompt,
    pushMessageBeforeLive,
    pruneTaskChatBuffer,
    markTaskChatStarted,
    ingestCommand,
    upsertExecuteBlock,
    upsertStepLiveDelta,
    upsertStreamingDelta,
    finalizeAssistant,
    hasAssistantAfterLastUser,
    hasEmptyAssistantPlaceholder,
  } = ctx;

  const setNotice = (message: string, projectId: string = activeProjectId.value): void => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.apiNotice.value = message;
    if (rt.noticeTimer !== null) {
      try {
        clearTimeout(rt.noticeTimer);
      } catch {
        // ignore
      }
      rt.noticeTimer = null;
    }
    rt.noticeTimer = window.setTimeout(() => {
      rt.noticeTimer = null;
      rt.apiNotice.value = null;
    }, 3000);
  };

  const clearNotice = (projectId: string = activeProjectId.value): void => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.apiNotice.value = null;
    if (rt.noticeTimer !== null) {
      try {
        clearTimeout(rt.noticeTimer);
      } catch {
        // ignore
      }
      rt.noticeTimer = null;
    }
  };

  const resetTaskState = (): void => {
    tasks.value = [];
    selectedId.value = null;
    expanded.value = new Set();
    plansByTaskId.value = new Map();
  };

  const ensurePlan = async (taskId: string): Promise<void> => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    const pid = normalizeProjectId(activeProjectId.value);
    const rt = getRuntime(pid);
    if ((rt.plansByTaskId.value.get(id)?.length ?? 0) > 0) return;
    const inFlight = rt.planFetchInFlightByTaskId.get(id);
    if (inFlight) {
      await inFlight;
      return;
    }

    const op = (async () => {
      try {
        const plan = await api.get<PlanStep[]>(withWorkspaceQuery(`/api/tasks/${id}/plan`));
        rt.plansByTaskId.value.set(id, Array.isArray(plan) ? plan : []);
        rt.plansByTaskId.value = new Map(rt.plansByTaskId.value);
      } catch {
        // ignore
      }
    })().finally(() => {
      rt.planFetchInFlightByTaskId.delete(id);
    });

    rt.planFetchInFlightByTaskId.set(id, op);
    try {
      await op;
    } catch {}
  };

  const togglePlan = (taskId: string): void => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    const next = new Set(expanded.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded.value = next;
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
      rt.queueStatus.value = await api.post<TaskQueueStatus>(withWorkspaceQueryFor(pid, "/api/task-queue/run"), {});
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

  const loadTasks = async (projectId: string = activeProjectId.value): Promise<void> => {
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    rt.tasks.value = await api.get<Task[]>(withWorkspaceQueryFor(pid, "/api/tasks?limit=100"));
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

  const onTaskEvent = (payload: { event: TaskEventPayload["event"]; data: unknown }, rt?: ProjectRuntime): void => {
    const state = ctx.runtimeOrActive(rt);
    pruneTaskChatBuffer(state);
    if (payload.event === "task:updated") {
      const t = payload.data as Task;
      upsertTask(t, state);
      return;
    }
    if (payload.event === "command") {
      const data = payload.data as { taskId: string; command: string };
      markTaskChatStarted(data.taskId, state);
      ingestCommand(data.command, state, null);
      upsertExecuteBlock(`task:${String(data.taskId ?? "").trim()}:${randomId("cmd")}`, data.command, "", state);
      return;
    }
    if (payload.event === "message:delta") {
      const data = payload.data as { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" };
      if (data.role === "assistant") {
        markTaskChatStarted(data.taskId, state);
        if (data.source === "step") {
          upsertStepLiveDelta(data.delta, state);
        } else {
          upsertStreamingDelta(data.delta, state);
        }
      }
      return;
    }
    if (payload.event === "task:started") {
      const t = payload.data as Task;
      upsertTask(t, state);
      finalizeCommandBlock(state);
      markTaskChatStarted(t.id, state);
      return;
    }
    if (payload.event === "task:planned") {
      const data = payload.data as { task: Task; plan?: Array<{ stepNumber: number; title: string; description?: string | null }> };
      upsertTask(data.task, state);
      markTaskChatStarted(data.task.id, state);
      if (Array.isArray(data.plan) && data.plan.length > 0) {
        const steps: PlanStep[] = data.plan.map((step) => ({
          id: step.stepNumber,
          taskId: data.task.id,
          stepNumber: step.stepNumber,
          title: step.title,
          description: step.description ?? null,
          status: "pending",
          startedAt: null,
          completedAt: null,
        }));
        state.plansByTaskId.value.set(data.task.id, steps);
        state.plansByTaskId.value = new Map(state.plansByTaskId.value);
      }
      return;
    }
    if (payload.event === "task:running") {
      const t = payload.data as Task;
      upsertTask(t, state);
      markTaskChatStarted(t.id, state);
      return;
    }
    if (payload.event === "step:started") {
      const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
      markTaskChatStarted(data.taskId, state);
      const plan = state.plansByTaskId.value.get(data.taskId);
      if (plan) {
        for (const s of plan) {
          if (s.stepNumber === data.step.stepNumber) s.status = "running";
        }
        state.plansByTaskId.value = new Map(state.plansByTaskId.value);
      }
      clearStepLive(state);
      return;
    }
    if (payload.event === "step:completed") {
      const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
      markTaskChatStarted(data.taskId, state);
      const plan = state.plansByTaskId.value.get(data.taskId);
      if (plan) {
        for (const s of plan) {
          if (s.stepNumber === data.step.stepNumber) s.status = "completed";
        }
        state.plansByTaskId.value = new Map(state.plansByTaskId.value);
      }
      clearStepLive(state);
      return;
    }
    if (payload.event === "message") {
      const data = payload.data as { taskId: string; role: string; content: string };
      const taskId = String(data.taskId ?? "").trim();
      const role = String(data.role ?? "").trim();
      const content = String(data.content ?? "");

      if (role === "user" && !state.startedTaskIds.has(taskId)) {
        ctx.bufferTaskChatEvent(taskId, { kind: "message", role: "user", content }, state);
        return;
      }
      if (role !== "user") {
        markTaskChatStarted(taskId, state);
      }
      if (role === "assistant") {
        finalizeAssistant(content, state);
        return;
      }
      if (role === "user") {
        const normalized = content.trim();
        if (
          state.messages.value.some(
            (m) => m.role === "user" && m.kind === "text" && String(m.content ?? "").trim() === normalized,
          )
        ) {
          return;
        }
        pushMessageBeforeLive({ role: "user", kind: "text", content }, state);
        const task = state.tasks.value.find((t) => t.id === taskId) ?? null;
        const status = String(task?.status ?? "");
        if (status === "pending" || status === "planning" || status === "running") {
          if (!hasEmptyAssistantPlaceholder(state)) {
            pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
          }
        }
        return;
      }
      if (role === "system") {
        pushMessageBeforeLive({ role: "system", kind: "text", content }, state);
        return;
      }
      return;
    }
    if (payload.event === "task:completed") {
      const t = payload.data as Task;
      markTaskChatStarted(t.id, state);
      upsertTask(t, state);
      clearStepLive(state);
      finalizeCommandBlock(state);
      if (t.result && t.result.trim() && !hasAssistantAfterLastUser(state)) {
        finalizeAssistant(t.result, state);
      }
      flushQueuedPrompts(state);
      void loadQueueStatus();
      return;
    }
    if (payload.event === "task:failed") {
      const data = payload.data as { task: Task; error: string };
      markTaskChatStarted(data.task.id, state);
      upsertTask(data.task, state);
      clearStepLive(state);
      finalizeCommandBlock(state);
      pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` }, state);
      flushQueuedPrompts(state);
      void loadQueueStatus();
      return;
    }
    if (payload.event === "task:cancelled") {
      const t = payload.data as Task;
      markTaskChatStarted(t.id, state);
      upsertTask(t, state);
      clearStepLive(state);
      finalizeCommandBlock(state);
      pushMessageBeforeLive({ role: "system", kind: "text", content: "[已终止]" }, state);
      flushQueuedPrompts(state);
      void loadQueueStatus();
      return;
    }
  };

  const reorderPendingTasks = async (ids: string[], projectId: string = activeProjectId.value): Promise<void> => {
    apiError.value = null;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    const normalized = (ids ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
    if (normalized.length === 0) {
      return;
    }

    const pending = rt.tasks.value.filter((t) => t.status === "pending");
    const priorQueueOrderById = new Map<string, number>();
    for (const t of pending) {
      priorQueueOrderById.set(t.id, (t as unknown as { queueOrder?: number }).queueOrder ?? 0);
    }
    const orderIndex = new Map<string, number>();
    for (let i = 0; i < normalized.length; i++) {
      orderIndex.set(normalized[i]!, i);
    }
    const base = (() => {
      let min = Number.POSITIVE_INFINITY;
      for (const t of pending) {
        const q = (t as unknown as { queueOrder?: number }).queueOrder;
        if (typeof q === "number" && Number.isFinite(q)) min = Math.min(min, q);
      }
      return Number.isFinite(min) ? Math.floor(min) : Date.now();
    })();

    rt.tasks.value = rt.tasks.value.map((t) => {
      if (t.status !== "pending") return t;
      const idx = orderIndex.get(t.id);
      if (idx == null) return t;
      return { ...(t as object), queueOrder: base + idx } as Task;
    });

    try {
      const res = await api.post<{ success: boolean; tasks: Task[] }>(withWorkspaceQueryFor(pid, "/api/tasks/reorder"), {
        ids: normalized,
      });
      for (const task of res?.tasks ?? []) {
        upsertTask(task, rt);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;

      rt.tasks.value = rt.tasks.value.map((t) => {
        if (t.status !== "pending") return t;
        const prior = priorQueueOrderById.get(t.id);
        if (prior == null) return t;
        return { ...(t as object), queueOrder: prior } as Task;
      });
    }
  };

  const pendingIdsInQueueOrder = (): string[] => {
    return tasks.value
      .filter((t) => t.status === "pending")
      .slice()
      .sort((a, b) => {
        if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      })
      .map((t) => t.id);
  };

  const updateQueuedTask = async (id: string, updates: Record<string, unknown>): Promise<void> => {
    apiError.value = null;
    clearNotice();
    try {
      const res = await api.patch<{ success: boolean; task?: Task }>(withWorkspaceQuery(`/api/tasks/${id}`), updates);
      if (res?.task) {
        upsertTask(res.task);
      } else {
        await loadTasks();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
    }
  };

  const updateQueuedTaskAndRun = async (id: string, updates: Record<string, unknown>): Promise<void> => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;

    await updateQueuedTask(taskId, updates);
    if (apiError.value) {
      return;
    }

    const ids = pendingIdsInQueueOrder();
    const next = ids.filter((x) => x !== taskId);
    next.push(taskId);
    await reorderPendingTasks(next);
    if (apiError.value) {
      return;
    }

    await runTaskQueue();
  };

  const refreshTaskRow = async (id: string, projectId: string = activeProjectId.value): Promise<void> => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    try {
      const detail = await api.get<TaskDetail>(withWorkspaceQueryFor(pid, `/api/tasks/${taskId}`));
      upsertTask(detail, rt);
      if (Array.isArray(detail.plan)) {
        rt.plansByTaskId.value.set(taskId, detail.plan);
        rt.plansByTaskId.value = new Map(rt.plansByTaskId.value);
      }
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
    const created = await createTask(input);
    if (created) taskCreateDialogOpen.value = false;
  };

  const submitTaskCreateAndRun = async (input: CreateTaskInput): Promise<void> => {
    const created = await createTask(input);
    if (!created) {
      return;
    }
    taskCreateDialogOpen.value = false;
    await runTaskQueue();
  };

  const setTaskRunBusy = (id: string, busy: boolean, projectId: string = activeProjectId.value): void => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    const next = new Set(rt.runBusyIds.value);
    if (busy) next.add(taskId);
    else next.delete(taskId);
    rt.runBusyIds.value = next;
  };

  const mockSingleTaskRun = (taskId: string, projectId: string = activeProjectId.value): void => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    const pid = normalizeProjectId(projectId);
    const rt = getRuntime(pid);
    const now = Date.now();

    const existing = rt.tasks.value.find((t) => t.id === id);
    if (!existing) return;

    upsertTask({ ...existing, status: "running", startedAt: now, completedAt: null, error: null, result: null }, rt);
    window.setTimeout(() => {
      const t = rt.tasks.value.find((x) => x.id === id);
      if (!t) return;
      upsertTask({ ...t, status: "completed", completedAt: Date.now(), result: "mock: completed", error: null }, rt);
    }, 900);
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
      const res = await api.post<{ success: boolean; taskId?: string; state?: string; mode?: string }>(
        withWorkspaceQueryFor(pid, `/api/tasks/${taskId}/run`),
        {},
      );
      void res;
      setNotice(`Task ${taskId.slice(0, 8)} scheduled`, pid);
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
    const t = tasks.value.find((x) => x.id === taskId);
    if (t && (t.status === "running" || t.status === "planning")) {
      apiError.value = "任务执行中，无法删除（请先终止）";
      return;
    }
    pendingDeleteTaskId.value = taskId;
    deleteConfirmOpen.value = true;
    void nextTick(() => deleteConfirmButtonEl.value?.focus());
  };

  const cancelDeleteTask = (): void => {
    deleteConfirmOpen.value = false;
    pendingDeleteTaskId.value = null;
  };

  const confirmDeleteTask = async (): Promise<void> => {
    const taskId = pendingDeleteTaskId.value;
    deleteConfirmOpen.value = false;
    pendingDeleteTaskId.value = null;
    if (!taskId) return;

    apiError.value = null;
    try {
      await api.delete<{ success: boolean }>(withWorkspaceQuery(`/api/tasks/${taskId}`));
      tasks.value = tasks.value.filter((x) => x.id !== taskId);
      expanded.value = new Set([...expanded.value].filter((x) => x !== taskId));
      plansByTaskId.value.delete(taskId);
      plansByTaskId.value = new Map(plansByTaskId.value);

      if (selectedId.value === taskId) {
        selectedId.value = tasks.value[0]?.id ?? null;
      }
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

  const interruptActive = (): void => {
    activeRuntime.value.ws?.interrupt();
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
    ensurePlan,
    togglePlan,
    loadModels,
    loadQueueStatus,
    runTaskQueue,
    pauseTaskQueue,
    reorderPendingTasks,
    loadTasks,
    upsertTask,
    onTaskEvent,
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
    interruptActive,
    clearActiveChat,
    resumeTaskThread,
    addPendingImages,
    clearPendingImages,
    openTaskCreateDialog,
    closeTaskCreateDialog,
    select,
  };
}

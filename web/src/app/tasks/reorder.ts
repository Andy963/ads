import type { Task } from "../../api/types";
import type { ChatActions } from "../chat";
import type { AppContext } from "../controller";

export function createTaskReorderActions(
  ctx: AppContext & ChatActions,
  deps: {
    clearNotice: (projectId?: string) => void;
    loadTasks: (projectId?: string) => Promise<void>;
    runTaskQueue: (projectId?: string) => Promise<void>;
    upsertTask: (t: Task) => void;
  },
) {
  const { api, apiError, withWorkspaceQuery, withWorkspaceQueryFor, activeProjectId, normalizeProjectId, getRuntime, tasks } = ctx;
  const { clearNotice, loadTasks, runTaskQueue, upsertTask } = deps;

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
        upsertTask(task);
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

  return { pendingIdsInQueueOrder, reorderPendingTasks, updateQueuedTask, updateQueuedTaskAndRun };
}


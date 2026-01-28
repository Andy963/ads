import type { TaskQueue } from "../tasks/queue.js";
import type { TaskStore } from "../tasks/store.js";
import type { Task, TaskMessage, TaskStatus } from "../tasks/types.js";

export type TaskRunMode = "manual" | "all" | "single";

export type SingleTaskRunResult =
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string; taskId?: string } }
  | { status: 202; body: { success: true; mode: TaskRunMode; taskId: string; state: "running" | "requested" }; task: Task }
  | { status: 200; body: { success: true; mode: TaskRunMode; taskId: string; state: "scheduled" }; task: Task; auditMessage?: TaskMessage };

export type TaskRunControllerContext = {
  taskStore: TaskStore;
  taskQueue: Pick<TaskQueue, "pause" | "resume" | "notifyNewTask">;
  queueRunning: boolean;
};

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isActiveStatus(status: TaskStatus): boolean {
  return status === "planning" || status === "running";
}

function shouldNormalizeToPending(status: TaskStatus): boolean {
  return status === "queued" || status === "paused";
}

function toFrontQueueOrder(store: TaskStore, now: number): number {
  const pending = store.listTasks({ status: "pending", limit: 2000 });
  if (pending.length === 0) {
    return now;
  }
  let min = pending[0]?.queueOrder ?? now;
  for (const task of pending) {
    const order = typeof task.queueOrder === "number" && Number.isFinite(task.queueOrder) ? task.queueOrder : now;
    if (order < min) {
      min = order;
    }
  }
  const next = min - 1;
  // Guard against NaN/Infinity. Also keep queueOrder in safe integer range.
  if (!Number.isFinite(next)) {
    return now;
  }
  if (next < Number.MIN_SAFE_INTEGER) {
    return Number.MIN_SAFE_INTEGER;
  }
  return next;
}

export class TaskRunController {
  private mode: TaskRunMode = "manual";
  private singleTaskId: string | null = null;

  getMode(): TaskRunMode {
    return this.mode;
  }

  setModeAll(): void {
    this.mode = "all";
    this.singleTaskId = null;
  }

  setModeManual(): void {
    this.mode = "manual";
    this.singleTaskId = null;
  }

  /**
   * Requests a "run this task only" execution.
   *
   * Behavior:
   * - idempotent while the single-run is in progress (202, no requeue / no extra audit record)
   * - if another task is active, returns 409
   * - if task is not found: 404
   * - if task is terminal: 409 (use retry endpoint instead)
   */
  requestSingleTaskRun(ctx: TaskRunControllerContext, taskId: string, now = Date.now()): SingleTaskRunResult {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return { status: 404, body: { error: "Not Found" } };
    }

    const task = ctx.taskStore.getTask(id);
    if (!task) {
      return { status: 404, body: { error: "Not Found" } };
    }

    if (this.mode === "single") {
      if (this.singleTaskId === id) {
        const latest = ctx.taskStore.getTask(id) ?? task;
        const state = isActiveStatus(latest.status) ? "running" : "requested";
        return { status: 202, body: { success: true, mode: "single", taskId: id, state }, task: latest };
      }
      return { status: 409, body: { error: "Another single-task run is in progress", taskId: this.singleTaskId ?? undefined } };
    }

    // If the queue is already running in "all" mode, running a single task would be misleading.
    if (ctx.queueRunning) {
      return { status: 409, body: { error: "Task queue is running" } };
    }

    const activeTaskId = ctx.taskStore.getActiveTaskId();
    if (activeTaskId) {
      if (activeTaskId === id) {
        return { status: 202, body: { success: true, mode: this.mode, taskId: id, state: "running" }, task };
      }
      return { status: 409, body: { error: "Another task is active", taskId: activeTaskId } };
    }

    if (isTerminalStatus(task.status)) {
      return { status: 409, body: { error: `Task not runnable in status: ${task.status}` } };
    }
    if (isActiveStatus(task.status)) {
      return { status: 202, body: { success: true, mode: this.mode, taskId: id, state: "running" }, task };
    }

    // Switch to single-run mode before resuming to keep idempotency window consistent.
    this.mode = "single";
    this.singleTaskId = id;

    const frontOrder = toFrontQueueOrder(ctx.taskStore, now);
    const updates: Partial<Omit<Task, "id">> = { queueOrder: frontOrder };
    if (shouldNormalizeToPending(task.status)) {
      updates.status = "pending";
    }
    const updated = ctx.taskStore.updateTask(id, updates, now);

    ctx.taskQueue.resume();
    ctx.queueRunning = true;
    ctx.taskQueue.notifyNewTask();

    let auditMessage: TaskMessage | undefined;
    try {
      auditMessage = ctx.taskStore.addMessage({
        taskId: id,
        planStepId: null,
        role: "system",
        content: "Audit: single-task run requested via API",
        messageType: "audit",
        modelUsed: null,
        tokenCount: null,
        createdAt: now,
      });
    } catch {
      // ignore audit failures (best-effort)
    }

    return {
      status: 200,
      body: { success: true, mode: "single", taskId: id, state: "scheduled" },
      task: updated,
      auditMessage,
    };
  }

  /**
   * Called by the web layer after receiving a terminal event.
   * Returns true if the controller paused the queue.
   */
  onTaskTerminal(ctx: TaskRunControllerContext, taskId: string): boolean {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return false;
    }
    if (this.mode !== "single" || this.singleTaskId !== id) {
      return false;
    }
    try {
      ctx.taskQueue.pause("single-task");
    } catch {
      // ignore
    }
    ctx.queueRunning = false;
    this.mode = "manual";
    this.singleTaskId = null;
    return true;
  }

  /**
   * When running a single task, we must avoid promoting queued tasks,
   * otherwise other tasks' statuses change even though they won't run.
   */
  shouldPromoteQueuedTasksOnTerminal(taskId: string): boolean {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return true;
    }
    return !(this.mode === "single" && this.singleTaskId === id);
  }
}


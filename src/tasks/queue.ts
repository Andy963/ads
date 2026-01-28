import { EventEmitter } from "node:events";

import type { TaskStore } from "./store.js";
import type { PlanStepInput, Task } from "./types.js";
import type { TaskExecutor } from "./executor.js";
import type { TaskPlanner } from "./planner.js";
import type { TaskQueueEventMap, TaskQueueEventName } from "./events.js";

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown };
  return candidate.name === "AbortError";
}

function createAbortError(message = "Aborted"): Error {
  const error = new Error(message);
  (error as { name?: string }).name = "AbortError";
  return error;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown error");
}

export class TaskQueue extends EventEmitter {
  private readonly store: TaskStore;
  private readonly planner: TaskPlanner;
  private readonly executor: TaskExecutor;

  private paused = false;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private runningTaskId: string | null = null;
  private runningAbort: AbortController | null = null;

  constructor(options: { store: TaskStore; planner: TaskPlanner; executor: TaskExecutor }) {
    super();
    this.store = options.store;
    this.planner = options.planner;
    this.executor = options.executor;
  }

  override on<E extends TaskQueueEventName>(event: E, listener: (payload: TaskQueueEventMap[E]) => void): this {
    return super.on(event, listener);
  }

  override emit<E extends TaskQueueEventName>(event: E, payload: TaskQueueEventMap[E]): boolean {
    return super.emit(event, payload);
  }

  start(): Promise<void> {
    if (this.loopPromise) {
      return this.loopPromise;
    }
    this.stopped = false;
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null;
    });
    return this.loopPromise;
  }

  stop(): void {
    this.stopped = true;
    this.paused = false;
    this.runningAbort?.abort();
    this.notifyNewTask();
  }

  pause(reason?: string): void {
    this.paused = true;
    this.emit("queue:paused", { reason });
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.emit("queue:resumed", {});
    this.notifyNewTask();
    void this.start();
  }

  notifyNewTask(): void {
    if (this.wake) {
      const resolver = this.wake;
      this.wake = null;
      resolver();
    }
  }

  cancel(taskId: string): void {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return;
    }
    if (this.runningTaskId === id && this.runningAbort) {
      try {
        this.store.updateTask(id, { status: "cancelled", error: "cancelled" }, Date.now());
      } catch {
        // ignore
      }
      this.runningAbort.abort();
      this.notifyNewTask();
      return;
    }
    try {
      this.store.updateTask(id, { status: "cancelled", error: "cancelled" }, Date.now());
    } catch {
      // ignore
    }
    this.notifyNewTask();
  }

  retry(taskId: string): void {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return;
    }
    const task = this.store.getTask(id);
    if (!task) {
      return;
    }
    this.store.updateTask(
      id,
      {
        status: "pending",
        error: null,
        result: null,
        completedAt: null,
        startedAt: null,
        retryCount: 0,
      },
      Date.now(),
    );
    this.notifyNewTask();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.paused) {
        await this.waitForWake();
        continue;
      }

      const task = this.store.claimNextPendingTask(Date.now());
      if (!task) {
        await this.waitForWake();
        continue;
      }

      this.runningTaskId = task.id;
      this.runningAbort = new AbortController();

      this.emit("task:started", { task });

      try {
        // Plan
        const plan = await this.planner.generatePlan(task, { signal: this.runningAbort.signal });
        if (this.runningAbort.signal.aborted || this.store.getTask(task.id)?.status === "cancelled") {
          throw createAbortError();
        }
        this.store.setPlan(task.id, plan);
        this.emit("task:planned", { task, plan });

        // Run
        const runningTask = this.store.getTask(task.id) ?? task;
        this.emit("task:running", { task: runningTask });

        const hooks = {
          onStepStart: (step: PlanStepInput) => this.emit("step:started", { task: runningTask, step }),
          onStepComplete: (step: PlanStepInput, output: string) => {
            void output;
            this.emit("step:completed", { task: runningTask, step });
          },
          onMessage: (message: { role: string; content: string; modelUsed?: string | null }) =>
            this.emit("message", { task: runningTask, role: message.role, content: message.content }),
          onMessageDelta: (message: { role: string; delta: string; modelUsed?: string | null }) =>
            this.emit("message:delta", {
              task: runningTask,
              role: message.role,
              delta: message.delta,
              modelUsed: message.modelUsed,
              source: "step",
            }),
          onCommand: (payload: { command: string }) => this.emit("command", { task: runningTask, command: payload.command }),
        };

        const { resultSummary } = await this.executor.execute(runningTask, plan, {
          signal: this.runningAbort.signal,
          hooks,
        });
        if (this.runningAbort.signal.aborted || this.store.getTask(task.id)?.status === "cancelled") {
          throw createAbortError();
        }

        const completed = this.store.updateTask(
          task.id,
          { status: "completed", result: resultSummary ?? null, error: null },
          Date.now(),
        );
        try {
          if (completed.result && completed.result.trim()) {
            this.store.saveContext(completed.id, { contextType: "summary", content: completed.result }, Date.now());
          }
          const conversationId = String(completed.threadId ?? "").trim();
          if (conversationId && completed.result && completed.result.trim()) {
            this.store.upsertConversation({ id: conversationId, taskId: completed.id, title: completed.title, updatedAt: Date.now() }, Date.now());
            this.store.addConversationMessage({
              conversationId,
              taskId: completed.id,
              role: "system",
              content: `[任务完成摘要]\n${completed.result}`,
              modelId: null,
              tokenCount: null,
              metadata: { kind: "task_summary" },
              createdAt: Date.now(),
            });
          }
        } catch {
          // ignore
        }
        this.emit("task:completed", { task: completed });
      } catch (error) {
        if (isAbortError(error)) {
          const cancelled = this.store.updateTask(task.id, { status: "cancelled", error: "cancelled" }, Date.now());
          try {
            this.store.saveContext(cancelled.id, { contextType: "summary", content: "[已取消]" }, Date.now());
          } catch {
            // ignore
          }
          this.emit("task:cancelled", { task: cancelled });
        } else {
          await this.handleError(task, error);
        }
      } finally {
        this.runningAbort = null;
        this.runningTaskId = null;
      }
    }
  }

  private async handleError(task: Task, error: unknown): Promise<void> {
    const message = formatError(error);
    const current = this.store.getTask(task.id) ?? task;
    const nextRetry = current.retryCount + 1;
    if (nextRetry <= current.maxRetries) {
      this.store.updateTask(
        task.id,
        {
          status: "pending",
          retryCount: nextRetry,
          error: message,
          result: null,
          completedAt: null,
          startedAt: null,
        },
        Date.now(),
      );
      this.emit("task:failed", { task: { ...current, status: "pending", retryCount: nextRetry, error: message }, error: message });
      this.notifyNewTask();
      return;
    }

    const failed = this.store.updateTask(task.id, { status: "failed", error: message }, Date.now());
    try {
      this.store.saveContext(failed.id, { contextType: "summary", content: `[失败]\n${message}` }, Date.now());
    } catch {
      // ignore
    }
    this.emit("task:failed", { task: failed, error: message });
  }

  private async waitForWake(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.wake) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, 1000);
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

import { EventEmitter } from "node:events";

import { createAbortError, isAbortError } from "../utils/abort.js";
import { getErrorMessage } from "../utils/error.js";
import { createLogger } from "../utils/logger.js";
import { TransientModelRetryExhaustedError } from "../agents/adapters/transientModelRetry.js";

import type { TaskStore } from "./store.js";
import type { Task } from "./types.js";
import type { TaskExecutor } from "./executor.js";
import type { TaskQueueEventMap, TaskQueueEventName } from "./events.js";

const logger = createLogger("TaskQueue");

export const TASK_UPSTREAM_RETRY_BASE_DELAY_ENV = "ADS_TASK_UPSTREAM_RETRY_BASE_DELAY_MS";
export const TASK_UPSTREAM_RETRY_MAX_DELAY_ENV = "ADS_TASK_UPSTREAM_RETRY_MAX_DELAY_MS";
const DEFAULT_TASK_UPSTREAM_RETRY_BASE_DELAY_MS = 60_000;
const DEFAULT_TASK_UPSTREAM_RETRY_MAX_DELAY_MS = 15 * 60_000;

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function resolveTaskUpstreamRetryDelayMs(retryCount: number): number {
  const baseDelayMs = parseNonNegativeInteger(
    process.env[TASK_UPSTREAM_RETRY_BASE_DELAY_ENV],
    DEFAULT_TASK_UPSTREAM_RETRY_BASE_DELAY_MS,
  );
  const maxDelayMs = parseNonNegativeInteger(
    process.env[TASK_UPSTREAM_RETRY_MAX_DELAY_ENV],
    DEFAULT_TASK_UPSTREAM_RETRY_MAX_DELAY_MS,
  );
  if (baseDelayMs === 0 || maxDelayMs === 0) {
    return 0;
  }
  const exponent = Math.max(0, Math.floor(retryCount) - 1);
  const delayMs = exponent >= 53 ? Number.POSITIVE_INFINITY : baseDelayMs * 2 ** exponent;
  return Math.min(delayMs, maxDelayMs);
}

export class TaskQueue extends EventEmitter {
  private readonly store: TaskStore;
  private readonly executor: TaskExecutor;

  private paused = false;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private runningTaskId: string | null = null;
  private runningAbort: AbortController | null = null;

  constructor(options: { store: TaskStore; executor: TaskExecutor }) {
    super();
    this.store = options.store;
    this.executor = options.executor;
  }

  override on<E extends TaskQueueEventName>(event: E, listener: (payload: TaskQueueEventMap[E]) => void): this {
    return super.on(event, listener);
  }

  override emit<E extends TaskQueueEventName>(event: E, payload: TaskQueueEventMap[E]): boolean {
    try {
      return super.emit(event, payload);
    } catch (error) {
      // A throwing listener must never break the queue's control flow — e.g. a failing
      // broadcast on the terminal "task:completed" event must not be caught by runLoop's
      // try/catch and mistaken for a task failure (which would retry/cancel a done task).
      logger.warn(`[TaskQueue] listener for "${String(event)}" threw: ${getErrorMessage(error)}`);
      return false;
    }
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
        nextAttemptAt: null,
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
        // Run
        const runningTask = this.store.getTask(task.id) ?? task;
        this.emit("task:running", { task: runningTask });

        const hooks = {
          onMessage: (message: { role: string; content: string; modelUsed?: string | null }) =>
            this.emit("message", { task: runningTask, role: message.role, content: message.content }),
          onMessageDelta: (message: {
            role: string;
            delta: string;
            modelUsed?: string | null;
            source?: "step" | "chat";
          }) =>
            this.emit("message:delta", {
              task: runningTask,
              role: message.role,
              delta: message.delta,
              modelUsed: message.modelUsed,
              source: message.source ?? "chat",
            }),
          onCommand: (payload: { command: string }) => this.emit("command", { task: runningTask, command: payload.command }),
          onGoalUpdate: (goal: {
            status: string;
            objective: string;
            tokensUsed: number;
            timeUsedSeconds: number;
            tokenBudget: number | null;
          }) => this.emit("goal:status", { task: runningTask, goal }),
          onGoalCleared: () => this.emit("goal:cleared", { task: runningTask }),
        };

        const { resultSummary } = await this.executor.execute(runningTask, {
          signal: this.runningAbort.signal,
          hooks,
        });
        if (this.runningAbort.signal.aborted || this.store.getTask(task.id)?.status === "cancelled") {
          throw createAbortError("Aborted");
        }

        const completed = this.store.updateTask(
          task.id,
          { status: "completed", result: resultSummary ?? null, error: null, nextAttemptAt: null },
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
    const message = getErrorMessage(error);
    const current = this.store.getTask(task.id) ?? task;
    const nextRetry = current.retryCount + 1;
    if (nextRetry <= current.maxRetries) {
      const retryDelayMs =
        error instanceof TransientModelRetryExhaustedError ? resolveTaskUpstreamRetryDelayMs(nextRetry) : 0;
      const now = Date.now();
      const pending = this.store.updateTask(
        task.id,
        {
          status: "pending",
          retryCount: nextRetry,
          nextAttemptAt: retryDelayMs > 0 ? now + retryDelayMs : null,
          error: message,
          result: null,
          completedAt: null,
          startedAt: null,
        },
        now,
      );
      this.emit("task:failed", { task: pending, error: message });
      this.notifyNewTask();
      return;
    }

    const failed = this.store.updateTask(task.id, { status: "failed", error: message, nextAttemptAt: null }, Date.now());
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

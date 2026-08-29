import type { TaskStore } from "../../tasks/store.js";

type QueueLifecycleContext = {
  runController: {
    setModeAll(admittedTaskIds?: Iterable<string>): void;
    setModeManual(): void;
  };
  taskStore?: Pick<TaskStore, "listTasks">;
  queueAutoStart?: boolean;
  taskQueue: {
    resume(): void;
    pause(reason: string): void;
  };
  queueRunning: boolean;
};

export function startQueueInAllMode<T extends QueueLifecycleContext>(ctx: T): T {
  // A live context always provides taskStore. Keep the legacy/test adapter
  // behavior when a lightweight context cannot provide the snapshot method.
  const listTasks = ctx.taskStore?.listTasks;
  const admittedTaskIds =
    ctx.queueAutoStart || typeof listTasks !== "function"
      ? undefined
      : listTasks.call(ctx.taskStore, { status: "queued", limit: Number.MAX_SAFE_INTEGER }).map((task) => task.id);
  ctx.runController.setModeAll(admittedTaskIds);
  ctx.taskQueue.resume();
  ctx.queueRunning = true;
  return ctx;
}

export function pauseQueueInManualMode<T extends QueueLifecycleContext>(ctx: T, reason: string): T {
  ctx.runController.setModeManual();
  ctx.taskQueue.pause(reason);
  ctx.queueRunning = false;
  return ctx;
}

type QueueLifecycleContext = {
  runController: {
    setModeAll(): void;
    setModeManual(): void;
  };
  taskQueue: {
    resume(): void;
    pause(reason: string): void;
  };
  queueRunning: boolean;
};

export function startQueueInAllMode<T extends QueueLifecycleContext>(ctx: T): T {
  ctx.runController.setModeAll();
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

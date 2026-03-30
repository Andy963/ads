import { safeParseJson } from "../../../utils/json.js";
import { notifyTaskTerminalViaTelegram } from "../../taskNotifications/telegramNotifier.js";
import { buildWorkspacePatch, type WorkspacePatchPayload } from "../../gitPatch.js";
import { broadcastTaskStart } from "../../taskStartBroadcast.js";
import { pauseQueueInManualMode, startQueueInAllMode } from "../../taskQueue/control.js";
import type { Logger } from "../../../utils/logger.js";
import type { TaskQueueContext } from "./types.js";
import { recordTaskQueueMetric } from "./metrics.js";

type ChangedPathsContext = { paths?: unknown };
type TaskWorkspacePatchArtifact = {
  paths: string[];
  patch: WorkspacePatchPayload | null;
  reason?: string;
  createdAt: number;
};

function recordTaskWorkspacePatchArtifact(
  ctx: TaskQueueContext,
  taskId: string,
  now = Date.now(),
): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;

  let contexts: ReturnType<typeof ctx.taskStore.getContext> = [];
  try {
    contexts = ctx.taskStore.getContext(id);
  } catch {
    contexts = [];
  }
  if (contexts.some((context) => context.contextType === "artifact:workspace_patch")) {
    return;
  }

  const changedCtx = (() => {
    for (let i = contexts.length - 1; i >= 0; i -= 1) {
      const context = contexts[i];
      if (context && context.contextType === "artifact:changed_paths") return context;
    }
    return null;
  })();

  const parsed = changedCtx ? safeParseJson<ChangedPathsContext>(changedCtx.content) : null;
  const paths = Array.isArray(parsed?.paths)
    ? (parsed.paths as unknown[]).map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];

  let patch: WorkspacePatchPayload | null = null;
  let reason = "";
  const latestRun = (() => {
    try {
      return ctx.taskStore.getLatestTaskRun(id);
    } catch {
      return null;
    }
  })();
  const patchRoot =
    latestRun?.executionIsolation === "required" && latestRun.worktreeDir
      ? latestRun.worktreeDir
      : ctx.workspaceRoot;
  const patchBaseRef =
    latestRun?.executionIsolation === "required" && latestRun.worktreeDir
      ? (latestRun.baseHead ?? undefined)
      : undefined;
  if (paths.length === 0) {
    reason = "no_changed_paths_recorded";
  } else {
    try {
      patch = buildWorkspacePatch(
        patchRoot,
        paths,
        patchBaseRef ? { baseRef: patchBaseRef } : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reason = `patch_error:${message}`;
    }
    if (!patch && !reason) {
      reason = "patch_not_available";
    }
  }

  const artifact: TaskWorkspacePatchArtifact = {
    paths,
    patch,
    reason: reason || undefined,
    createdAt: now,
  };
  try {
    ctx.taskStore.saveContext(
      id,
      {
        contextType: "artifact:workspace_patch",
        content: JSON.stringify(artifact),
        createdAt: now,
      },
      now,
    );
  } catch {
    // ignore
  }
}

export function promoteQueuedTasksToPending(ctx: TaskQueueContext, args: {
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): void {
  if (!ctx.queueRunning || ctx.dequeueInProgress) {
    return;
  }
  ctx.dequeueInProgress = true;
  try {
    if (!ctx.queueRunning || ctx.taskStore.getActiveTaskId()) {
      return;
    }

    const now = Date.now();
    let promoted = 0;
    while (true) {
      const dequeued = ctx.taskStore.dequeueNextQueuedTask(now);
      if (!dequeued) {
        break;
      }
      promoted += 1;
      args.broadcastToSession(ctx.sessionId, {
        type: "task:event",
        event: "task:updated",
        data: dequeued,
        ts: now,
      });
    }
    if (promoted > 0) {
      ctx.taskQueue.notifyNewTask();
    }
  } finally {
    ctx.dequeueInProgress = false;
  }
}

export function bindTaskQueueRuntime(args: {
  ctx: TaskQueueContext;
  logger: Logger;
  available: boolean;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
  recordToSessionHistories: (
    sessionId: string,
    entry: { role: string; text: string; ts: number; kind?: string },
  ) => void;
  ensureReviewEnqueued: (taskId: string, now?: number) => void;
  runReviewLoop: () => Promise<void>;
  onReviewEnqueueFailure: (taskId: string, error: unknown) => void;
}) {
  const { ctx } = args;
  const promote = () =>
    promoteQueuedTasksToPending(ctx, { broadcastToSession: args.broadcastToSession });

  ctx.taskQueue.on("task:started", ({ task }) => {
    const ts = Date.now();
    recordTaskQueueMetric(ctx.metrics, "TASK_STARTED", { ts, taskId: task.id });
    const prompt = String((task as { prompt?: unknown } | null)?.prompt ?? "").trim();
    if (!prompt) {
      args.logger.warn(`[Web] task prompt is empty; broadcasting placeholder taskId=${task.id}`);
    }
    broadcastTaskStart({
      task,
      ts,
      markPromptInjected: (taskId: string, now: number) => {
        try {
          return ctx.taskStore.markPromptInjected(taskId, now);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          args.logger.warn(`[Web] markPromptInjected failed taskId=${taskId} err=${message}`);
          throw error;
        }
      },
      recordHistory: (entry) => args.recordToSessionHistories(ctx.sessionId, entry),
      recordMetric: (name, event) => recordTaskQueueMetric(ctx.metrics, name, event),
      broadcast: (payload) => args.broadcastToSession(ctx.sessionId, payload),
    });
  });
  ctx.taskQueue.on("task:running", ({ task }) =>
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "task:running",
      data: task,
      ts: Date.now(),
    }),
  );
  ctx.taskQueue.on("message", ({ task, role, content }) =>
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "message",
      data: { taskId: task.id, role, content },
      ts: Date.now(),
    }),
  );
  ctx.taskQueue.on("message:delta", ({ task, role, delta, modelUsed, source }) =>
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "message:delta",
      data: { taskId: task.id, role, delta, modelUsed, source },
      ts: Date.now(),
    }),
  );
  ctx.taskQueue.on("command", ({ task, command }) => {
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "command",
      data: { taskId: task.id, command },
      ts: Date.now(),
    });
    args.recordToSessionHistories(ctx.sessionId, {
      role: "status",
      text: `$ ${command}`,
      ts: Date.now(),
      kind: "command",
    });
  });
  ctx.taskQueue.on("task:completed", ({ task }) => {
    recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
    recordTaskWorkspacePatchArtifact(ctx, task.id);
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "task:completed",
      data: task,
      ts: Date.now(),
    });
    if (task.result && task.result.trim()) {
      args.recordToSessionHistories(ctx.sessionId, {
        role: "ai",
        text: task.result.trim(),
        ts: Date.now(),
      });
    }
    if (task.reviewRequired) {
      try {
        args.ensureReviewEnqueued(task.id);
      } catch (error) {
        args.onReviewEnqueueFailure(task.id, error);
      }
    }
    try {
      notifyTaskTerminalViaTelegram({
        logger: args.logger,
        workspaceRoot: ctx.workspaceRoot,
        task,
        terminalStatus: "completed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn(
        `[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`,
      );
    }
    if (ctx.runController.onTaskTerminal(ctx, task.id)) {
      return;
    }
    promote();
    ctx.runController.maybePauseAfterDrain(ctx);
  });
  ctx.taskQueue.on("task:failed", ({ task, error }) => {
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "task:failed",
      data: { task, error },
      ts: Date.now(),
    });
    args.recordToSessionHistories(ctx.sessionId, {
      role: "status",
      text: `[Task failed] ${error}`,
      ts: Date.now(),
      kind: "error",
    });
    if (task.status === "failed") {
      recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
      recordTaskWorkspacePatchArtifact(ctx, task.id);
      try {
        notifyTaskTerminalViaTelegram({
          logger: args.logger,
          workspaceRoot: ctx.workspaceRoot,
          task,
          terminalStatus: "failed",
        });
      } catch (notifyError) {
        const message = notifyError instanceof Error ? notifyError.message : String(notifyError);
        args.logger.warn(
          `[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`,
        );
      }
      if (ctx.runController.onTaskTerminal(ctx, task.id)) {
        return;
      }
      promote();
      ctx.runController.maybePauseAfterDrain(ctx);
    }
  });
  ctx.taskQueue.on("task:cancelled", ({ task }) => {
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "task:cancelled",
      data: task,
      ts: Date.now(),
    });
    args.recordToSessionHistories(ctx.sessionId, {
      role: "status",
      text: "[Cancelled]",
      ts: Date.now(),
      kind: "status",
    });
    recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
    recordTaskWorkspacePatchArtifact(ctx, task.id);
    try {
      notifyTaskTerminalViaTelegram({
        logger: args.logger,
        workspaceRoot: ctx.workspaceRoot,
        task,
        terminalStatus: "cancelled",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn(
        `[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`,
      );
    }
    if (ctx.runController.onTaskTerminal(ctx, task.id)) {
      return;
    }
    promote();
    ctx.runController.maybePauseAfterDrain(ctx);
  });

  void args.runReviewLoop();

  if (args.available) {
    const status = ctx.getStatusOrchestrator().status();
    if (ctx.queueAutoStart) {
      startQueueInAllMode(ctx);
      void ctx.taskQueue.start();
      args.logger.info(`[Web] TaskQueue started workspace=${ctx.workspaceRoot}`);
      promote();
    } else {
      pauseQueueInManualMode(ctx, "manual");
      void ctx.taskQueue.start();
      args.logger.info(`[Web] TaskQueue paused workspace=${ctx.workspaceRoot}`);
    }
    if (!status.ready) {
      args.logger.warn(`[Web] Agent not ready yet; tasks may fail: ${status.error ?? "unknown"}`);
    }
  }
}

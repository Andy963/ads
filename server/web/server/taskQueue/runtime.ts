import { safeParseJson } from "../../../utils/json.js";
import { dispatchTaskTerminalEvent } from "../../taskNotifications/taskNotificationDispatcher.js";
import { buildWorkspacePatch, type WorkspacePatchPayload } from "../../gitPatch.js";
import { broadcastTaskStart } from "../../taskStartBroadcast.js";
import { pauseQueueInManualMode, startQueueInAllMode } from "../../taskQueue/control.js";
import type { Logger } from "../../../utils/logger.js";
import type { Task } from "../../../tasks/types.js";
import type { TaskQueueContext } from "./types.js";
import { recordTaskQueueMetric } from "./metrics.js";
import {
  mergeReviewSummary,
  reviewSubjectForTask,
} from "../../../tasks/reviewWorkflow.js";
import type { TaskReviewSummary } from "../../../tasks/types.js";
import { isTerminalReviewStatus } from "../../../tasks/reviewData.js";

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
  if (paths.length === 0) {
    reason = "no_changed_paths_recorded";
  } else {
    const latestRun = ctx.taskStore.getLatestTaskRun(id);
    const patchRoot = latestRun?.executionIsolation === "required"
      ? String(latestRun.worktreeDir ?? "").trim()
      : ctx.workspaceRoot;
    if (!patchRoot) {
      reason = "isolated_worktree_unavailable";
    }
    try {
      if (!reason) patch = buildWorkspacePatch(patchRoot, paths, { baseRef: latestRun?.baseHead ?? "" });
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

function uniqueTaskIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))];
}

function persistReviewSummary(
  ctx: TaskQueueContext,
  subject: Task,
  patch: Partial<TaskReviewSummary>,
  relatedTaskIds: string[] = [],
): TaskReviewSummary {
  const root = ctx.taskStore.getRootTask(subject.id) ?? subject;
  const summary = mergeReviewSummary(root, {
    ...patch,
    required: true,
    rootTaskId: root.id,
  });
  const taskIds = uniqueTaskIds([root.id, subject.id, ...relatedTaskIds]);
  for (const taskId of taskIds) {
    ctx.taskStore.updateTaskReview(taskId, summary, Date.now());
  }
  return summary;
}

function emitReviewNotification(args: {
  ctx: TaskQueueContext;
  task: Task;
  summary: TaskReviewSummary;
  event: string;
  message: string;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): void {
  const now = Date.now();
  args.broadcastToSession(args.ctx.sessionId, {
    type: "task:event",
    event: "review:updated",
    data: {
      taskId: args.task.id,
      rootTaskId: args.summary.rootTaskId,
      event: args.event,
      message: args.message,
      review: args.summary,
    },
    ts: now,
  });
}

function persistReviewError(args: {
  ctx: TaskQueueContext;
  subject: Task;
  reason: string;
  task: Task;
  logger: Logger;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): void {
  const reviewTaskId = args.task.category === "review" ? args.task.id : undefined;
  const summary = persistReviewSummary(args.ctx, args.subject, {
    status: "error",
    stateReason: args.reason,
    controlState: "needs_intervention",
    reviewedAt: Date.now(),
    ...(reviewTaskId ? { reviewTaskId } : {}),
  }, reviewTaskId ? [reviewTaskId] : []);
  args.logger.warn(`[Web][TaskReview] ${args.reason} taskId=${args.subject.id}`);
  emitReviewNotification({
    ctx: args.ctx,
    task: args.task,
    summary,
    event: "error",
    message: args.reason,
    broadcastToSession: args.broadcastToSession,
  });
}

export function markReviewTaskStarted(args: {
  ctx: TaskQueueContext;
  task: Task;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): void {
  if (args.task.category !== "review") return;
  const subject = reviewSubjectForTask(args.task, (id) => args.ctx.taskStore.getTask(id));
  if (!subject) return;
  const root = args.ctx.taskStore.getRootTask(subject.id) ?? subject;
  const currentReview = root.review;
  if (currentReview?.required && isTerminalReviewStatus(currentReview.status)) return;
  if (currentReview?.status === "in_review" && currentReview.reviewTaskId === args.task.id) return;
  const summary = persistReviewSummary(args.ctx, subject, {
    status: "in_review",
    reviewTaskId: args.task.id,
    reviewStartedAt: args.task.startedAt ?? Date.now(),
    reviewerModelId: args.task.model,
    reviewerAgentId: args.task.agentId,
    stateReason: null,
  }, [args.task.id]);
  emitReviewNotification({
    ctx: args.ctx,
    task: subject,
    summary,
    event: "started",
    message: `Review started with ${summary.reviewerModelDisplayName ?? args.task.model}.`,
    broadcastToSession: args.broadcastToSession,
  });
}

export function markReviewTaskFailed(args: {
  ctx: TaskQueueContext;
  task: Task;
  error: string;
  logger: Logger;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): void {
  if (args.task.category !== "review") return;
  const subject = reviewSubjectForTask(args.task, (id) => args.ctx.taskStore.getTask(id));
  if (!subject) return;
  const root = args.ctx.taskStore.getRootTask(subject.id) ?? subject;
  if (root.review?.required && isTerminalReviewStatus(root.review.status)) return;
  persistReviewError({ ...args, subject, reason: `Review execution failed: ${args.error}` });
}

export function createTaskWorkflowFollowup(args: {
  ctx: TaskQueueContext;
  task: Task;
  logger: Logger;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): void {
  // Decommissioned: automated review/rework task creation loops are retired in favor of GitHub-native PR workflow.
  void args;
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
    const admittedTaskIds = ctx.runController.getAllModeAdmissionTaskIds();
    let promoted = 0;
    while (true) {
      const dequeued = ctx.taskStore.dequeueNextQueuedTask(now, admittedTaskIds ?? undefined);
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
      recordMetric: (name, event) => recordTaskQueueMetric(ctx.metrics, name, event),
      broadcast: (payload) => args.broadcastToSession(ctx.sessionId, payload),
    });
    markReviewTaskStarted({
      ctx,
      task,
      broadcastToSession: args.broadcastToSession,
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
  });
  ctx.taskQueue.on("goal:status", ({ task, goal }) => {
    args.broadcastToSession(ctx.sessionId, {
      type: "goal:status",
      data: {
        taskId: task.id,
        status: goal.status,
        objective: goal.objective,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        tokenBudget: goal.tokenBudget,
      },
      ts: Date.now(),
    });
  });
  ctx.taskQueue.on("goal:cleared", ({ task }) => {
    args.broadcastToSession(ctx.sessionId, {
      type: "goal:cleared",
      data: { taskId: task.id },
      ts: Date.now(),
    });
  });
  ctx.taskQueue.on("task:completed", ({ task }) => {
    recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
    recordTaskWorkspacePatchArtifact(ctx, task.id);
    createTaskWorkflowFollowup({
      ctx,
      task,
      logger: args.logger,
      broadcastToSession: args.broadcastToSession,
    });
    const completedTask = ctx.taskStore.getTask(task.id) ?? task;
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "task:completed",
      data: completedTask,
      ts: Date.now(),
    });
    try {
      dispatchTaskTerminalEvent({
        taskId: task.id,
        title: task.prompt,
        status: "completed",
        workspaceRoot: ctx.workspaceRoot,
        startedAt: task.startedAt ?? null,
        completedAt: task.completedAt ?? Date.now(),
        result: task.result,
      }, {
        logger: args.logger,
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
    markReviewTaskFailed({
      ctx,
      task,
      error,
      logger: args.logger,
      broadcastToSession: args.broadcastToSession,
    });
    args.broadcastToSession(ctx.sessionId, {
      type: "task:event",
      event: "task:failed",
      data: { task, error },
      ts: Date.now(),
    });
    if (task.status === "failed") {
      recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
      recordTaskWorkspacePatchArtifact(ctx, task.id);
      try {
        dispatchTaskTerminalEvent({
          taskId: task.id,
          title: task.prompt,
          status: "failed",
          workspaceRoot: ctx.workspaceRoot,
          startedAt: task.startedAt ?? null,
          completedAt: task.completedAt ?? Date.now(),
          error: task.error,
        }, {
          logger: args.logger,
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
    recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
    recordTaskWorkspacePatchArtifact(ctx, task.id);
    try {
      dispatchTaskTerminalEvent({
        taskId: task.id,
        title: task.prompt,
        status: "cancelled",
        workspaceRoot: ctx.workspaceRoot,
        startedAt: task.startedAt ?? null,
        completedAt: task.completedAt ?? Date.now(),
      }, {
        logger: args.logger,
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

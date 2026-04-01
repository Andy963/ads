import type { TaskRunApplyStatus, TaskRunCaptureStatus } from "../../../tasks/types.js";
import type { TaskQueueContext } from "./types.js";

export type FailReviewPipelineArgs = {
  taskId: string;
  taskRunId?: string | null;
  queueItemId?: string | null;
  errorMessage: string;
  now?: number;
  captureStatus?: TaskRunCaptureStatus | null;
  applyStatus?: TaskRunApplyStatus | null;
};

export function resolveCurrentTaskReviewRunId(
  ctx: TaskQueueContext,
  taskId: string,
  snapshotId: string,
): string | null {
  try {
    const latestTask = ctx.taskStore.getTask(taskId);
    if (!latestTask) {
      return null;
    }
    if (String(latestTask.reviewSnapshotId ?? "").trim() !== String(snapshotId ?? "").trim()) {
      return null;
    }
    return ctx.taskStore.getLatestTaskRun(taskId)?.id ?? null;
  } catch {
    return null;
  }
}

export function createFailReviewPipeline(args: {
  ctx: TaskQueueContext;
  sessionId: string;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
}): (options: FailReviewPipelineArgs) => void {
  return (options: FailReviewPipelineArgs): void => {
    const ts = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
    const errorMessage = String(options.errorMessage ?? "").trim() || "review_failed";
    const queueItemId = String(options.queueItemId ?? "").trim();
    if (queueItemId) {
      try {
        args.ctx.reviewStore.completeItem(queueItemId, { status: "failed", error: errorMessage }, ts);
      } catch {
        // ignore
      }
    }

    const taskRunId = String(options.taskRunId ?? "").trim();
    if (taskRunId) {
      try {
        const boundRun = args.ctx.taskStore.getTaskRun(taskRunId);
        if (boundRun) {
          const nextCaptureStatus =
            options.captureStatus === undefined
              ? undefined
              : options.captureStatus ?? (boundRun.captureStatus === "pending" ? "failed" : boundRun.captureStatus);
          const nextApplyStatus =
            options.applyStatus === undefined
              ? boundRun.applyStatus === "pending"
                ? "failed"
                : boundRun.applyStatus
              : options.applyStatus ?? (boundRun.applyStatus === "pending" ? "failed" : boundRun.applyStatus);
          args.ctx.taskStore.updateTaskRun(
            boundRun.id,
            {
              ...(nextCaptureStatus ? { captureStatus: nextCaptureStatus } : {}),
              ...(nextApplyStatus ? { applyStatus: nextApplyStatus } : {}),
              status: "failed",
              error: errorMessage,
            },
            ts,
          );
        }
      } catch {
        // ignore
      }
    }

    try {
      const latestTask = args.ctx.taskStore.getTask(options.taskId);
      if (latestTask && latestTask.reviewStatus !== "passed") {
        const existingConclusion = String(latestTask.reviewConclusion ?? "").trim();
        const reviewedAt =
          typeof latestTask.reviewedAt === "number" &&
          Number.isFinite(latestTask.reviewedAt) &&
          latestTask.reviewedAt > 0
            ? latestTask.reviewedAt
            : ts;
        const failedTask = args.ctx.taskStore.updateTask(
          latestTask.id,
          {
            reviewStatus: "failed",
            reviewConclusion: existingConclusion || errorMessage,
            reviewedAt,
            status: "failed",
            error: errorMessage,
          },
          ts,
        );
        args.broadcastToSession(args.sessionId, {
          type: "task:event",
          event: "task:updated",
          data: failedTask,
          ts,
        });
      }
    } catch {
      // ignore
    }
  };
}

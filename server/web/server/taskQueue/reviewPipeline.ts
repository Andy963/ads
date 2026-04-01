import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { TaskQueueContext } from "./types.js";
import { hashTaskId } from "./metrics.js";
import { createFailReviewPipeline, resolveCurrentTaskReviewRunId } from "./reviewPipelineFailure.js";
import { buildReviewerPrompt, parseWebReviewVerdict } from "./reviewPipelinePrompt.js";
import { finalizeReviewDecision } from "./reviewPipelineResult.js";
import { invokeQueueReviewer } from "./reviewPipelineReviewerRun.js";
import { createPendingReviewSnapshot, resolveReviewerWorkingDirectory } from "./reviewPipelineSnapshot.js";

export function createReviewPipeline(args: {
  ctx: TaskQueueContext;
  sessionId: string;
  reviewSessionManager?: SessionManager;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
  broadcastToReviewerSession?: (sessionId: string, payload: unknown) => void;
  recordToReviewerHistories?: (
    sessionId: string,
    entry: { role: string; text: string; ts: number; kind?: string },
  ) => void;
}) {
  const { ctx, sessionId } = args;
  let reviewLoopRunning = false;
  const reviewerEnabled = Boolean(args.reviewSessionManager);
  const failReviewPipeline = createFailReviewPipeline({
    ctx,
    sessionId,
    broadcastToSession: args.broadcastToSession,
  });

  const runReviewLoop = async (): Promise<void> => {
    if (!reviewerEnabled || reviewLoopRunning) {
      return;
    }
    reviewLoopRunning = true;

    try {
      while (true) {
        const now = Date.now();
        const item = ctx.reviewStore.claimNextPending(now);
        if (!item) {
          return;
        }

        const reviewerSessionManager = args.reviewSessionManager!;
        const reviewUserId = hashTaskId(`review:${item.id}`);
        const task = ctx.taskStore.getTask(item.taskId);
        if (!task) {
          ctx.reviewStore.completeItem(item.id, { status: "failed", error: "task_not_found" }, now);
          continue;
        }

        let runningTask = task;
        if (task.reviewStatus !== "running") {
          try {
            runningTask = ctx.taskStore.updateTask(task.id, { reviewStatus: "running" }, now);
            args.broadcastToSession(sessionId, {
              type: "task:event",
              event: "task:updated",
              data: runningTask,
              ts: now,
            });
          } catch {
            // ignore
          }
        }

        const snapshot = ctx.reviewStore.getSnapshot(item.snapshotId);
        if (!snapshot) {
          failReviewPipeline({
            taskId: task.id,
            taskRunId: resolveCurrentTaskReviewRunId(ctx, task.id, item.snapshotId),
            queueItemId: item.id,
            errorMessage: "snapshot_not_found",
            now,
          });
          continue;
        }

        const prompt = buildReviewerPrompt(
          { id: runningTask.id, title: runningTask.title, prompt: runningTask.prompt },
          { patch: snapshot.patch, changedFiles: snapshot.changedFiles },
        );
        const reviewerCwd = resolveReviewerWorkingDirectory(ctx, snapshot);
        if (!reviewerCwd) {
          const errorMessage = "review_snapshot_worktree_missing";
          failReviewPipeline({
            taskId: task.id,
            taskRunId: snapshot.taskRunId,
            queueItemId: item.id,
            errorMessage,
            now,
          });
          args.broadcastToReviewerSession?.(sessionId, {
            type: "error",
            message: `[Review failed] taskId=${task.id} snapshotId=${item.snapshotId} err=${errorMessage}`,
          });
          continue;
        }

        try {
          const responseText = await invokeQueueReviewer({
            reviewSessionManager: reviewerSessionManager,
            reviewUserId,
            reviewerCwd,
            prompt,
          });
          const parsed = parseWebReviewVerdict(responseText);
          if (!parsed.ok) {
            const errorMessage = `invalid_review_verdict_json:${parsed.error}`;
            const ts = Date.now();
            failReviewPipeline({
              taskId: task.id,
              taskRunId: snapshot.taskRunId,
              queueItemId: item.id,
              errorMessage,
              now: ts,
            });
            args.broadcastToReviewerSession?.(sessionId, {
              type: "error",
              message: `[Review failed] taskId=${task.id} snapshotId=${item.snapshotId} err=${errorMessage}`,
            });
            continue;
          }

          await finalizeReviewDecision({
            ctx,
            sessionId,
            item,
            snapshot,
            runningTask,
            prompt,
            responseText,
            verdict: parsed.verdict,
            broadcastToSession: args.broadcastToSession,
            broadcastToReviewerSession: args.broadcastToReviewerSession,
            recordToReviewerHistories: args.recordToReviewerHistories,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const ts = Date.now();
          failReviewPipeline({
            taskId: task.id,
            taskRunId: snapshot.taskRunId,
            queueItemId: item.id,
            errorMessage: message,
            now: ts,
          });
          args.broadcastToReviewerSession?.(sessionId, {
            type: "error",
            message: `[Review failed] taskId=${task.id} snapshotId=${item.snapshotId} err=${message}`,
          });
          continue;
        }
      }
    } finally {
      reviewLoopRunning = false;
    }
  };

  const ensureReviewEnqueued = (taskId: string, now = Date.now()): void => {
    if (!reviewerEnabled) {
      return;
    }
    const task = ctx.taskStore.getTask(taskId);
    if (!task || !task.reviewRequired) {
      return;
    }
    if (
      task.reviewStatus === "passed" ||
      task.reviewStatus === "rejected" ||
      task.reviewStatus === "failed"
    ) {
      return;
    }

    const existingSnapshotId = String(task.reviewSnapshotId ?? "").trim();
    if (existingSnapshotId) {
      const open = ctx.reviewStore.getOpenQueueItemBySnapshotId(existingSnapshotId);
      if (!open) {
        try {
          ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: existingSnapshotId }, now);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failReviewPipeline({
            taskId: task.id,
            taskRunId: resolveCurrentTaskReviewRunId(ctx, task.id, existingSnapshotId),
            errorMessage: `review_queue_enqueue_failed:${message}`,
            now,
          });
          return;
        }
      }
      void runReviewLoop();
      return;
    }

    const preparedSnapshot = createPendingReviewSnapshot({ ctx, task, now });
    if (!preparedSnapshot.ok) {
      failReviewPipeline({
        taskId: task.id,
        taskRunId: preparedSnapshot.taskRunId,
        errorMessage: preparedSnapshot.errorMessage,
        now,
        captureStatus: preparedSnapshot.captureStatus,
        applyStatus: preparedSnapshot.applyStatus,
      });
      return;
    }

    const { snapshot } = preparedSnapshot;

    const pendingTask = ctx.taskStore.updateTask(
      task.id,
      { reviewStatus: "pending", reviewSnapshotId: snapshot.id },
      now,
    );
    args.broadcastToSession(sessionId, {
      type: "task:event",
      event: "task:updated",
      data: pendingTask,
      ts: now,
    });

    const open = ctx.reviewStore.getOpenQueueItemBySnapshotId(snapshot.id);
    if (!open) {
      try {
        ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failReviewPipeline({
          taskId: task.id,
          taskRunId: snapshot.taskRunId,
          errorMessage: `review_queue_enqueue_failed:${message}`,
          now,
        });
        return;
      }
    }

    void runReviewLoop();
  };

  return {
    runReviewLoop,
    ensureReviewEnqueued,
    failReviewPipeline,
  };
}

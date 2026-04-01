import { applyTaskRunChanges } from "../../../tasks/applyBack.js";
import { toReviewArtifactSummary, type ReviewArtifact, type ReviewQueueItem, type ReviewSnapshot } from "../../../tasks/reviewStore.js";
import type { Task, TaskRun } from "../../../tasks/types.js";
import type { TaskQueueContext } from "./types.js";
import { summarizeReviewArtifactText } from "./metrics.js";
import type { WebReviewVerdict } from "./reviewPipelinePrompt.js";

function appendApplyConclusionSuffix(result: { status: "blocked" | "failed"; message?: string }): string {
  return `\n\n[apply-back ${result.status}] ${result.message ?? "unknown error"}`;
}

async function applyReviewedTaskRunChanges(args: {
  ctx: TaskQueueContext;
  latestRun: TaskRun | null;
  verdictStatus: WebReviewVerdict["verdict"];
}): Promise<string> {
  const { latestRun, verdictStatus } = args;
  if (
    verdictStatus === "passed" &&
    latestRun?.executionIsolation === "required" &&
    latestRun.worktreeDir &&
    latestRun.baseHead
  ) {
    const applyResult = await args.ctx.getLock().runExclusive(async () => {
      const result = await applyTaskRunChanges({
        workspaceRoot: latestRun.workspaceRoot,
        worktreeDir: latestRun.worktreeDir!,
        baseHead: latestRun.baseHead!,
      });
      try {
        args.ctx.taskStore.updateTaskRun(
          latestRun.id,
          {
            applyStatus:
              result.status === "applied"
                ? "applied"
                : result.status === "skipped"
                  ? "skipped"
                  : result.status,
            status:
              result.status === "blocked" || result.status === "failed"
                ? "failed"
                : latestRun.status,
            error:
              result.status === "blocked" || result.status === "failed"
                ? (result.message ?? "apply-back failed")
                : null,
          },
          Date.now(),
        );
      } catch {
        // ignore
      }
      return result;
    });
    if (applyResult.status === "blocked" || applyResult.status === "failed") {
      return appendApplyConclusionSuffix({
        status: applyResult.status,
        message: applyResult.message,
      });
    }
    return "";
  }

  if (
    verdictStatus !== "passed" &&
    latestRun?.executionIsolation === "required" &&
    latestRun.applyStatus === "pending"
  ) {
    try {
      args.ctx.taskStore.updateTaskRun(
        latestRun.id,
        {
          applyStatus: "skipped",
          error: null,
        },
        Date.now(),
      );
    } catch {
      // ignore
    }
  }

  return "";
}

function updateReviewedTask(args: {
  ctx: TaskQueueContext;
  runningTask: Task;
  verdictStatus: WebReviewVerdict["verdict"];
  conclusion: string;
  applyConclusionSuffix: string;
}): Task {
  let updatedTask = args.runningTask;
  try {
    const ts = Date.now();
    const latest = args.ctx.taskStore.getTask(args.runningTask.id);
    if (latest?.reviewStatus === "passed") {
      const existingConclusion = String(latest.reviewConclusion ?? "").trim();
      const shouldOverwriteManual = !existingConclusion || existingConclusion === "manually marked as done";
      const reviewConclusion = shouldOverwriteManual ? args.conclusion : existingConclusion;
      const reviewedAt =
        typeof latest.reviewedAt === "number" && Number.isFinite(latest.reviewedAt) && latest.reviewedAt > 0
          ? latest.reviewedAt
          : ts;
      updatedTask = args.ctx.taskStore.updateTask(
        args.runningTask.id,
        {
          reviewConclusion: `${reviewConclusion}${args.applyConclusionSuffix}`,
          reviewedAt,
          ...(args.applyConclusionSuffix ? { status: "failed", error: args.applyConclusionSuffix.trim() } : {}),
        },
        ts,
      );
    } else {
      updatedTask = args.ctx.taskStore.updateTask(
        args.runningTask.id,
        {
          reviewStatus: args.verdictStatus,
          reviewConclusion: `${args.conclusion}${args.applyConclusionSuffix}`,
          reviewedAt: ts,
          ...(args.applyConclusionSuffix ? { status: "failed", error: args.applyConclusionSuffix.trim() } : {}),
        },
        ts,
      );
    }
  } catch {
    // ignore
  }
  return updatedTask;
}

export async function finalizeReviewDecision(args: {
  ctx: TaskQueueContext;
  sessionId: string;
  item: Pick<ReviewQueueItem, "id" | "snapshotId">;
  snapshot: ReviewSnapshot;
  runningTask: Task;
  prompt: string;
  responseText: string;
  verdict: WebReviewVerdict;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
  broadcastToReviewerSession?: (sessionId: string, payload: unknown) => void;
  recordToReviewerHistories?: (
    sessionId: string,
    entry: { role: string; text: string; ts: number; kind?: string },
  ) => void;
}): Promise<{ artifact: ReviewArtifact; updatedTask: Task }> {
  const verdictStatus = args.verdict.verdict;
  const conclusion = args.verdict.conclusion.trim();
  const previousArtifact = args.ctx.reviewStore.getLatestArtifact({ snapshotId: args.item.snapshotId });
  const artifact = args.ctx.reviewStore.createArtifact(
    {
      taskId: args.runningTask.id,
      snapshotId: args.item.snapshotId,
      queueItemId: args.item.id,
      scope: "queue",
      promptText: args.prompt,
      responseText: args.responseText,
      summaryText: summarizeReviewArtifactText(conclusion || args.responseText),
      verdict: verdictStatus,
      priorArtifactId: previousArtifact?.id ?? null,
    },
    Date.now(),
  );

  args.ctx.reviewStore.completeItem(args.item.id, { status: verdictStatus, conclusion }, Date.now());

  const latestRun = (() => {
    try {
      return args.snapshot.taskRunId ? args.ctx.taskStore.getTaskRun(args.snapshot.taskRunId) : null;
    } catch {
      return null;
    }
  })();
  const applyConclusionSuffix = await applyReviewedTaskRunChanges({
    ctx: args.ctx,
    latestRun,
    verdictStatus,
  });
  const updatedTask = updateReviewedTask({
    ctx: args.ctx,
    runningTask: args.runningTask,
    verdictStatus,
    conclusion,
    applyConclusionSuffix,
  });

  args.broadcastToSession(args.sessionId, {
    type: "task:event",
    event: "task:updated",
    data: updatedTask,
    ts: Date.now(),
  });

  const reviewSummary =
    `[Review ${verdictStatus.toUpperCase()}] taskId=${updatedTask.id} snapshotId=${args.item.snapshotId} reviewArtifactId=${artifact.id}\n\n${conclusion}`;
  args.broadcastToReviewerSession?.(args.sessionId, {
    type: "result",
    ok: true,
    output: reviewSummary,
    kind: "review",
  });
  args.broadcastToReviewerSession?.(args.sessionId, {
    type: "reviewer_artifact",
    artifact: toReviewArtifactSummary(artifact),
  });
  args.recordToReviewerHistories?.(args.sessionId, {
    role: "ai",
    text: reviewSummary,
    ts: Date.now(),
    kind: "review",
  });

  return { artifact, updatedTask };
}

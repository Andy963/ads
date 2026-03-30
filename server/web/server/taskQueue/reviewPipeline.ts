import { safeParseJson } from "../../../utils/json.js";
import { toReviewArtifactSummary, type ReviewStore } from "../../../tasks/reviewStore.js";
import { applyTaskRunChanges } from "../../../tasks/applyBack.js";
import { extractJsonPayload } from "../../../agents/tasks/schemas.js";
import { z } from "zod";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { WorkspacePatchPayload } from "../../gitPatch.js";
import type { TaskQueueContext } from "./types.js";
import { hashTaskId, summarizeReviewArtifactText } from "./metrics.js";

type ChangedPathsContext = { paths?: unknown };
type TaskWorkspacePatchArtifact = {
  paths: string[];
  patch: WorkspacePatchPayload | null;
  reason?: string;
  createdAt: number;
};
type TaskWorktreeReferenceContext = { worktreeDir?: string | null };
type TaskLikeWithModelParams = { modelParams?: unknown };

const WebReviewVerdictSchema = z
  .object({
    verdict: z.enum(["passed", "rejected"]),
    conclusion: z.string().min(1),
  })
  .passthrough();

type WebReviewVerdict = z.infer<typeof WebReviewVerdictSchema>;

function parseWebReviewVerdict(
  rawResponse: string,
): { ok: true; verdict: WebReviewVerdict } | { ok: false; error: string } {
  const payload = extractJsonPayload(rawResponse) ?? rawResponse;
  try {
    const parsed = JSON.parse(payload) as unknown;
    const verdict = WebReviewVerdictSchema.parse(parsed);
    return { ok: true, verdict };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function taskRequiresDedicatedReviewWorktree(task: TaskLikeWithModelParams | null | undefined): boolean {
  const modelParams = task?.modelParams;
  if (!modelParams || typeof modelParams !== "object" || Array.isArray(modelParams)) {
    return false;
  }
  const bootstrap = (modelParams as Record<string, unknown>).bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    return false;
  }
  return (bootstrap as Record<string, unknown>).enabled === true;
}

function resolveReviewSnapshotWorktreeDir(
  ctx: TaskQueueContext,
  task: { id: string; modelParams?: unknown },
): { ok: true; worktreeDir: string } | { ok: false; reason: "worktree_unresolved" } {
  try {
    const latestRun = ctx.taskStore.getLatestTaskRun(task.id);
    const worktreeDir = String(latestRun?.worktreeDir ?? "").trim();
    if (worktreeDir) {
      return { ok: true, worktreeDir };
    }
  } catch {
    // ignore
  }
  try {
    const contexts = ctx.taskStore.getContext(task.id);
    for (let i = contexts.length - 1; i >= 0; i -= 1) {
      const entry = contexts[i];
      if (!entry || entry.contextType !== "artifact:worktree_reference") {
        continue;
      }
      const parsed = safeParseJson<TaskWorktreeReferenceContext>(entry.content);
      const worktreeDir = String(parsed?.worktreeDir ?? "").trim();
      if (worktreeDir) {
        return { ok: true, worktreeDir };
      }
    }
  } catch {
    // ignore
  }
  if (taskRequiresDedicatedReviewWorktree(task)) {
    return { ok: false, reason: "worktree_unresolved" };
  }
  return { ok: true, worktreeDir: ctx.workspaceRoot };
}

function resolveReviewerWorkingDirectory(
  ctx: TaskQueueContext,
  snapshot: ReturnType<ReviewStore["getSnapshot"]>,
): string | null {
  if (!snapshot) {
    return null;
  }
  const worktreeDir = String(snapshot.worktreeDir ?? "").trim();
  if (snapshot.executionIsolation === "required") {
    return worktreeDir || null;
  }
  return worktreeDir || ctx.workspaceRoot;
}

function buildReviewerPrompt(
  task: { id: string; title: string; prompt: string },
  snapshot: { patch: WorkspacePatchPayload | null; changedFiles: string[] },
): string {
  const changedFiles = Array.isArray(snapshot.changedFiles) ? snapshot.changedFiles : [];
  const patchDiff = snapshot.patch?.diff ? String(snapshot.patch.diff) : "";
  const patchTruncated = Boolean(snapshot.patch?.truncated);
  const parts: string[] = [];
  parts.push("You are a strict code reviewer.");
  parts.push(
    "You MUST base your review only on the immutable snapshot below (changed files list + diff patch + summaries).",
  );
  parts.push("Do NOT run any tools. Do NOT assume current repository state. Do NOT ask questions.");
  parts.push("");
  parts.push("Task:");
  parts.push(`- taskId: ${task.id}`);
  parts.push(`- title: ${String(task.title ?? "").trim() || "(empty)"}`);
  parts.push("");
  parts.push("Goal (original prompt):");
  parts.push(String(task.prompt ?? "").trim() || "(empty)");
  parts.push("");
  parts.push("Snapshot:");
  parts.push(`- Diff truncated: ${patchTruncated ? "yes" : "no"}`);
  parts.push("");
  parts.push("Changed files:");
  if (changedFiles.length === 0) {
    parts.push("- (none)");
  } else {
    for (const file of changedFiles.slice(0, 200)) {
      parts.push(`- ${file}`);
    }
    if (changedFiles.length > 200) {
      parts.push(`- ... (${changedFiles.length - 200} more)`);
    }
  }
  parts.push("");
  parts.push("Diff:");
  parts.push("```diff");
  parts.push(patchDiff.trimEnd().slice(0, 200_000));
  parts.push("```");
  parts.push("");
  parts.push("Output:");
  parts.push('Return ONLY a single JSON object: {"verdict":"passed|rejected","conclusion":"..."}');
  parts.push("Do not wrap in markdown. No extra keys are required.");
  return `${parts.join("\n").trim()}\n`;
}

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

  const resolveCurrentTaskReviewRunId = (taskId: string, snapshotId: string): string | null => {
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
  };

  const failReviewPipeline = (args2: {
    taskId: string;
    taskRunId?: string | null;
    queueItemId?: string | null;
    errorMessage: string;
    now?: number;
    captureStatus?: "pending" | "ok" | "failed" | "skipped" | null;
    applyStatus?: "pending" | "applied" | "blocked" | "failed" | "skipped" | null;
  }): void => {
    const ts = typeof args2.now === "number" && Number.isFinite(args2.now) ? args2.now : Date.now();
    const errorMessage = String(args2.errorMessage ?? "").trim() || "review_failed";
    const queueItemId = String(args2.queueItemId ?? "").trim();
    if (queueItemId) {
      try {
        ctx.reviewStore.completeItem(queueItemId, { status: "failed", error: errorMessage }, ts);
      } catch {
        // ignore
      }
    }

    const taskRunId = String(args2.taskRunId ?? "").trim();
    if (taskRunId) {
      try {
        const boundRun = ctx.taskStore.getTaskRun(taskRunId);
        if (boundRun) {
          const nextCaptureStatus =
            args2.captureStatus === undefined
              ? undefined
              : args2.captureStatus ?? (boundRun.captureStatus === "pending" ? "failed" : boundRun.captureStatus);
          const nextApplyStatus =
            args2.applyStatus === undefined
              ? boundRun.applyStatus === "pending"
                ? "failed"
                : boundRun.applyStatus
              : args2.applyStatus ?? (boundRun.applyStatus === "pending" ? "failed" : boundRun.applyStatus);
          ctx.taskStore.updateTaskRun(
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
      const latestTask = ctx.taskStore.getTask(args2.taskId);
      if (latestTask && latestTask.reviewStatus !== "passed") {
        const existingConclusion = String(latestTask.reviewConclusion ?? "").trim();
        const reviewedAt =
          typeof latestTask.reviewedAt === "number" &&
          Number.isFinite(latestTask.reviewedAt) &&
          latestTask.reviewedAt > 0
            ? latestTask.reviewedAt
            : ts;
        const failedTask = ctx.taskStore.updateTask(
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
        args.broadcastToSession(sessionId, {
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
            taskRunId: resolveCurrentTaskReviewRunId(task.id, item.snapshotId),
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

        let responseText = "";
        try {
          reviewerSessionManager.dropSession(reviewUserId, { clearSavedThread: true });
        } catch {
          // ignore
        }
        try {
          const orchestrator = reviewerSessionManager.getOrCreate(reviewUserId, reviewerCwd, false);
          orchestrator.setWorkingDirectory(reviewerCwd);
          const status = orchestrator.status();
          if (!status.ready) {
            throw new Error(status.error ?? "reviewer agent not ready");
          }
          const agentId = orchestrator.getActiveAgentId();
          const result = await orchestrator.invokeAgent(agentId, prompt, { streaming: false });
          responseText =
            typeof (result as { response?: unknown } | null)?.response === "string"
              ? (result as { response: string }).response
              : String((result as { response?: unknown } | null)?.response ?? "");
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
        } finally {
          try {
            reviewerSessionManager.dropSession(reviewUserId, { clearSavedThread: true });
          } catch {
            // ignore
          }
        }

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

        const verdict = parsed.verdict;
        const verdictStatus = verdict.verdict;
        const conclusion = verdict.conclusion.trim();
        const previousArtifact = ctx.reviewStore.getLatestArtifact({ snapshotId: item.snapshotId });
        const artifact = ctx.reviewStore.createArtifact(
          {
            taskId: runningTask.id,
            snapshotId: item.snapshotId,
            queueItemId: item.id,
            scope: "queue",
            promptText: prompt,
            responseText,
            summaryText: summarizeReviewArtifactText(conclusion || responseText),
            verdict: verdictStatus,
            priorArtifactId: previousArtifact?.id ?? null,
          },
          Date.now(),
        );

        ctx.reviewStore.completeItem(item.id, { status: verdictStatus, conclusion }, Date.now());

        const latestRun = (() => {
          try {
            return snapshot.taskRunId ? ctx.taskStore.getTaskRun(snapshot.taskRunId) : null;
          } catch {
            return null;
          }
        })();
        let applyConclusionSuffix = "";
        if (
          verdictStatus === "passed" &&
          latestRun?.executionIsolation === "required" &&
          latestRun.worktreeDir &&
          latestRun.baseHead
        ) {
          const worktreeDir = latestRun.worktreeDir;
          const baseHead = latestRun.baseHead;
          const applyResult = await ctx.getLock().runExclusive(async () => {
            const result = await applyTaskRunChanges({
              workspaceRoot: latestRun.workspaceRoot,
              worktreeDir,
              baseHead,
            });
            try {
              ctx.taskStore.updateTaskRun(
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
            applyConclusionSuffix = `\n\n[apply-back ${applyResult.status}] ${applyResult.message ?? "unknown error"}`;
          }
        } else if (
          verdictStatus !== "passed" &&
          latestRun?.executionIsolation === "required" &&
          latestRun.applyStatus === "pending"
        ) {
          try {
            ctx.taskStore.updateTaskRun(
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

        let updatedTask = runningTask;
        try {
          const ts = Date.now();
          const latest = ctx.taskStore.getTask(runningTask.id);
          if (latest?.reviewStatus === "passed") {
            const existingConclusion = String(latest.reviewConclusion ?? "").trim();
            const shouldOverwriteManual =
              !existingConclusion || existingConclusion === "manually marked as done";
            const reviewConclusion = shouldOverwriteManual ? conclusion : existingConclusion;
            const reviewedAt =
              typeof latest.reviewedAt === "number" &&
              Number.isFinite(latest.reviewedAt) &&
              latest.reviewedAt > 0
                ? latest.reviewedAt
                : ts;
            updatedTask = ctx.taskStore.updateTask(
              runningTask.id,
              {
                reviewConclusion: `${reviewConclusion}${applyConclusionSuffix}`,
                reviewedAt,
                ...(applyConclusionSuffix
                  ? { status: "failed", error: applyConclusionSuffix.trim() }
                  : {}),
              },
              ts,
            );
          } else {
            updatedTask = ctx.taskStore.updateTask(
              runningTask.id,
              {
                reviewStatus: verdictStatus,
                reviewConclusion: `${conclusion}${applyConclusionSuffix}`,
                reviewedAt: ts,
                ...(applyConclusionSuffix
                  ? { status: "failed", error: applyConclusionSuffix.trim() }
                  : {}),
              },
              ts,
            );
          }
        } catch {
          // ignore
        }

        args.broadcastToSession(sessionId, {
          type: "task:event",
          event: "task:updated",
          data: updatedTask,
          ts: Date.now(),
        });

        const reviewSummary =
          `[Review ${verdictStatus.toUpperCase()}] taskId=${updatedTask.id} snapshotId=${item.snapshotId} reviewArtifactId=${artifact.id}\n\n${conclusion}`;
        args.broadcastToReviewerSession?.(sessionId, {
          type: "result",
          ok: true,
          output: reviewSummary,
          kind: "review",
        });
        args.broadcastToReviewerSession?.(sessionId, {
          type: "reviewer_artifact",
          artifact: toReviewArtifactSummary(artifact),
        });
        args.recordToReviewerHistories?.(sessionId, {
          role: "ai",
          text: reviewSummary,
          ts: Date.now(),
          kind: "review",
        });
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
            taskRunId: resolveCurrentTaskReviewRunId(task.id, existingSnapshotId),
            errorMessage: `review_queue_enqueue_failed:${message}`,
            now,
          });
          return;
        }
      }
      void runReviewLoop();
      return;
    }

    let patchArtifact: TaskWorkspacePatchArtifact | null = null;
    let changedFiles: string[] = [];
    const snapshotTaskRunId = (() => {
      try {
        return ctx.taskStore.getLatestTaskRun(task.id)?.id ?? null;
      } catch {
        return null;
      }
    })();
    try {
      const contexts = ctx.taskStore.getContext(taskId);
      const latestPatch =
        [...contexts].reverse().find((entry) => entry.contextType === "artifact:workspace_patch") ??
        null;
      patchArtifact = latestPatch ? safeParseJson<TaskWorkspacePatchArtifact>(latestPatch.content) : null;
      const latestChanged =
        [...contexts].reverse().find((entry) => entry.contextType === "artifact:changed_paths") ?? null;
      const changedParsed = latestChanged
        ? safeParseJson<ChangedPathsContext>(latestChanged.content)
        : null;
      changedFiles = Array.isArray(changedParsed?.paths)
        ? (changedParsed.paths as unknown[]).map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
    } catch {
      patchArtifact = null;
      changedFiles = [];
    }

    if (!patchArtifact?.patch) {
      failReviewPipeline({
        taskId: task.id,
        taskRunId: snapshotTaskRunId,
        errorMessage: "review_snapshot_patch_missing",
        now,
        captureStatus: "failed",
        applyStatus: "failed",
      });
      return;
    }

    const reviewWorktree = resolveReviewSnapshotWorktreeDir(ctx, task);
    if (!reviewWorktree.ok) {
      failReviewPipeline({
        taskId: task.id,
        taskRunId: snapshotTaskRunId,
        errorMessage: reviewWorktree.reason,
        now,
        captureStatus: "failed",
        applyStatus: "failed",
      });
      return;
    }

    let snapshot: ReturnType<ReviewStore["createSnapshot"]>;
    try {
      snapshot = ctx.reviewStore.createSnapshot(
        {
          taskId: task.id,
          taskRunId: snapshotTaskRunId,
          specRef: null,
          worktreeDir: reviewWorktree.worktreeDir,
          patch: patchArtifact.patch ?? null,
          changedFiles: patchArtifact.paths?.length ? patchArtifact.paths : changedFiles,
          lintSummary: "",
          testSummary: "",
        },
        now,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failReviewPipeline({
        taskId: task.id,
        taskRunId: snapshotTaskRunId,
        errorMessage: `review_snapshot_create_failed:${message}`,
        now,
        captureStatus: "failed",
        applyStatus: "failed",
      });
      return;
    }

    try {
      if (snapshotTaskRunId) {
        const boundRun = ctx.taskStore.getTaskRun(snapshotTaskRunId);
        if (boundRun) {
          ctx.taskStore.updateTaskRun(boundRun.id, { captureStatus: "ok" }, now);
        }
      }
    } catch {
      // ignore
    }

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

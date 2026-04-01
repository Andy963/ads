import { safeParseJson } from "../../../utils/json.js";
import type { ReviewSnapshot } from "../../../tasks/reviewStore.js";
import type { WorkspacePatchPayload } from "../../gitPatch.js";
import type { TaskQueueContext } from "./types.js";

type ChangedPathsContext = { paths?: unknown };
type TaskWorkspacePatchArtifact = {
  paths: string[];
  patch: WorkspacePatchPayload | null;
  reason?: string;
  createdAt: number;
};
type TaskWorktreeReferenceContext = { worktreeDir?: string | null };
type TaskLikeWithModelParams = { modelParams?: unknown };

export type CreatePendingReviewSnapshotResult =
  | {
      ok: true;
      snapshot: ReviewSnapshot;
      taskRunId: string | null;
    }
  | {
      ok: false;
      taskRunId: string | null;
      errorMessage: string;
      captureStatus: "failed";
      applyStatus: "failed";
    };

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

export function resolveReviewSnapshotWorktreeDir(
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

export function resolveReviewerWorkingDirectory(
  ctx: TaskQueueContext,
  snapshot: ReviewSnapshot | null,
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

export function createPendingReviewSnapshot(args: {
  ctx: TaskQueueContext;
  task: { id: string; modelParams?: unknown };
  now?: number;
}): CreatePendingReviewSnapshotResult {
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? args.now : Date.now();
  const snapshotTaskRunId = (() => {
    try {
      return args.ctx.taskStore.getLatestTaskRun(args.task.id)?.id ?? null;
    } catch {
      return null;
    }
  })();

  let patchArtifact: TaskWorkspacePatchArtifact | null = null;
  let changedFiles: string[] = [];
  try {
    const contexts = args.ctx.taskStore.getContext(args.task.id);
    const latestPatch =
      [...contexts].reverse().find((entry) => entry.contextType === "artifact:workspace_patch") ?? null;
    patchArtifact = latestPatch ? safeParseJson<TaskWorkspacePatchArtifact>(latestPatch.content) : null;
    const latestChanged =
      [...contexts].reverse().find((entry) => entry.contextType === "artifact:changed_paths") ?? null;
    const changedParsed = latestChanged ? safeParseJson<ChangedPathsContext>(latestChanged.content) : null;
    changedFiles = Array.isArray(changedParsed?.paths)
      ? (changedParsed.paths as unknown[]).map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
  } catch {
    patchArtifact = null;
    changedFiles = [];
  }

  if (!patchArtifact?.patch) {
    return {
      ok: false,
      taskRunId: snapshotTaskRunId,
      errorMessage: "review_snapshot_patch_missing",
      captureStatus: "failed",
      applyStatus: "failed",
    };
  }

  const reviewWorktree = resolveReviewSnapshotWorktreeDir(args.ctx, args.task);
  if (!reviewWorktree.ok) {
    return {
      ok: false,
      taskRunId: snapshotTaskRunId,
      errorMessage: reviewWorktree.reason,
      captureStatus: "failed",
      applyStatus: "failed",
    };
  }

  let snapshot: ReviewSnapshot;
  try {
    snapshot = args.ctx.reviewStore.createSnapshot(
      {
        taskId: args.task.id,
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
    return {
      ok: false,
      taskRunId: snapshotTaskRunId,
      errorMessage: `review_snapshot_create_failed:${message}`,
      captureStatus: "failed",
      applyStatus: "failed",
    };
  }

  try {
    if (snapshotTaskRunId) {
      const boundRun = args.ctx.taskStore.getTaskRun(snapshotTaskRunId);
      if (boundRun) {
        args.ctx.taskStore.updateTaskRun(boundRun.id, { captureStatus: "ok" }, now);
      }
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    snapshot,
    taskRunId: snapshotTaskRunId,
  };
}

import path from "node:path";

import type { Logger } from "../../../utils/logger.js";
import { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import { validateWorkspacePath } from "../api/routes/workspacePath.js";
import { createTaskQueueContext } from "./context.js";
import { createReviewPipeline } from "./reviewPipeline.js";
import { bindTaskQueueRuntime, promoteQueuedTasksToPending as promoteQueuedTasksToPendingRuntime } from "./runtime.js";
import type { TaskQueueContext } from "./types.js";

export { recordTaskQueueMetric } from "./metrics.js";
export type {
  TaskQueueMetricEvent,
  TaskQueueMetricName,
  TaskQueueMetrics,
  TaskQueueContext,
} from "./types.js";

export function createTaskQueueManager(deps: {
  workspaceRoot: string;
  allowedDirs: string[];
  adsStateDir: string;
  lockForWorkspace: (workspaceRoot: string) => AsyncLock;
  available: boolean;
  autoStart: boolean;
  logger: Logger;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
  recordToSessionHistories: (sessionId: string, entry: { role: string; text: string; ts: number; kind?: string }) => void;
  reviewSessionManager?: SessionManager;
  broadcastToReviewerSession?: (sessionId: string, payload: unknown) => void;
  recordToReviewerHistories?: (sessionId: string, entry: { role: string; text: string; ts: number; kind?: string }) => void;
}): {
  ensureTaskContext: (workspaceRootForContext: string) => TaskQueueContext;
  resolveTaskWorkspaceRoot: (url: URL) => string;
  resolveTaskContext: (url: URL) => TaskQueueContext;
  promoteQueuedTasksToPending: (ctx: TaskQueueContext) => void;
} {
  const taskContexts = new Map<string, TaskQueueContext>();

  const promoteQueuedTasksToPending = (ctx: TaskQueueContext): void =>
    promoteQueuedTasksToPendingRuntime(ctx, {
      broadcastToSession: deps.broadcastToSession,
    });

  const ensureTaskContext = (workspaceRootForContext: string): TaskQueueContext => {
    const key = String(workspaceRootForContext ?? "").trim() || deps.workspaceRoot;
    const existing = taskContexts.get(key);
    if (existing) {
      return existing;
    }

    const ctx = createTaskQueueContext({
      workspaceRoot: key,
      adsStateDir: deps.adsStateDir,
      autoStart: deps.autoStart,
      lockForWorkspace: deps.lockForWorkspace,
    });
    taskContexts.set(key, ctx);

    const reviewPipeline = createReviewPipeline({
      ctx,
      sessionId: ctx.sessionId,
      reviewSessionManager: deps.reviewSessionManager,
      broadcastToSession: deps.broadcastToSession,
      broadcastToReviewerSession: deps.broadcastToReviewerSession,
      recordToReviewerHistories: deps.recordToReviewerHistories,
    });

    bindTaskQueueRuntime({
      ctx,
      logger: deps.logger,
      available: deps.available,
      broadcastToSession: deps.broadcastToSession,
      recordToSessionHistories: deps.recordToSessionHistories,
      ensureReviewEnqueued: reviewPipeline.ensureReviewEnqueued,
      runReviewLoop: reviewPipeline.runReviewLoop,
      onReviewEnqueueFailure: (taskId, error) => {
        const message = error instanceof Error ? error.message : String(error);
        reviewPipeline.failReviewPipeline({
          taskId,
          taskRunId: ctx.taskStore.getLatestTaskRun(taskId)?.id ?? null,
          errorMessage: `review_enqueue_failed:${message}`,
          now: Date.now(),
          captureStatus: "failed",
        });
      },
    });

    return ctx;
  };

  const resolveTaskWorkspaceRoot = (url: URL): string => {
    const rawWorkspace = String(url.searchParams.get("workspace") ?? "").trim();
    if (!rawWorkspace) {
      return deps.workspaceRoot;
    }

    const validated = validateWorkspacePath({
      candidatePath: rawWorkspace,
      allowedDirs: deps.allowedDirs,
      allowWorkspaceRootFallback: false,
    });
    if (!validated.ok) {
      switch (validated.reason) {
        case "missing_path":
          return deps.workspaceRoot;
        case "not_exists":
          throw new Error(`Workspace does not exist: ${validated.absolutePath ?? path.resolve(rawWorkspace)}`);
        case "not_directory":
          throw new Error(
            `Workspace is not a directory: ${validated.resolvedPath ?? validated.absolutePath ?? path.resolve(rawWorkspace)}`,
          );
        case "not_allowed":
        default:
          throw new Error("Workspace is not allowed");
      }
    }

    return validated.workspaceRoot;
  };

  const resolveTaskContext = (url: URL): TaskQueueContext => {
    const targetWorkspaceRoot = resolveTaskWorkspaceRoot(url);
    return ensureTaskContext(targetWorkspaceRoot);
  };

  return {
    ensureTaskContext,
    resolveTaskWorkspaceRoot,
    resolveTaskContext,
    promoteQueuedTasksToPending,
  };
}

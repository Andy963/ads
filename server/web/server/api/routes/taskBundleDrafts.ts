import { z } from "zod";

import { startQueueInAllMode } from "../../../taskQueue/control.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";

import { taskBundleSchema, type TaskBundle } from "../../planner/taskBundle.js";
import { validateTaskBundleSpec } from "../../planner/specValidation.js";
import {
  approveTaskBundleDraft,
  deleteTaskBundleDraft,
  getTaskBundleDraft,
  listTaskBundleDrafts,
  setTaskBundleDraftError,
  updateTaskBundleDraft,
} from "../../planner/taskBundleDraftStore.js";
import { upsertTaskNotificationBinding } from "../../../taskNotifications/store.js";
import { materializeTaskBundleTasks } from "../../planner/taskBundleApprover.js";
import { readJsonBodyOrSendBadRequest, resolveTaskContextOrSendBadRequest } from "./shared.js";

const updateTaskBundleDraftSchema = z.object({ bundle: z.unknown() }).passthrough();
const approveTaskBundleDraftSchema = z.object({ runQueue: z.boolean().optional() }).passthrough();

function getDraftIdOrSendBadRequest(rawDraftId: unknown, res: ApiRouteContext["res"]): string | null {
  const draftId = String(rawDraftId ?? "").trim();
  if (draftId) {
    return draftId;
  }
  sendJson(res, 400, { error: "draftId is required" });
  return null;
}

function getDraftForWorkspaceOrSendError(args: {
  authUserId: string;
  draftId: string;
  workspaceRoot: string;
  res: ApiRouteContext["res"];
}): ReturnType<typeof getTaskBundleDraft> {
  const existing = getTaskBundleDraft({ authUserId: args.authUserId, draftId: args.draftId });
  if (!existing) {
    sendJson(args.res, 404, { error: "Not Found" });
    return null;
  }
  if (existing.workspaceRoot !== args.workspaceRoot) {
    sendJson(args.res, 409, { error: "Draft workspace mismatch" });
    return null;
  }
  return existing;
}

function maybePromoteApprovedDraftTasks(args: {
  deps: Pick<ApiSharedDeps, "logger" | "promoteQueuedTasksToPending">;
  taskCtx: ReturnType<ApiSharedDeps["resolveTaskContext"]>;
  draftId: string;
  runQueue: boolean;
  ownedApproval: boolean;
}): void {
  const shouldStartQueue = args.ownedApproval && args.runQueue;
  const shouldPromoteQueuedTasks = shouldStartQueue || (args.taskCtx.queueRunning && args.taskCtx.runController.getMode() === "all");
  if (shouldStartQueue) {
    startQueueInAllMode(args.taskCtx);
  }
  if (!shouldPromoteQueuedTasks) {
    return;
  }
  try {
    args.deps.promoteQueuedTasksToPending(args.taskCtx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.deps.logger.warn(`[Web][TaskQueue] promote queued tasks after approve failed draftId=${args.draftId} err=${message}`);
  }
}

export async function handleTaskBundleDraftRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url, auth } = ctx;
  const authUserId = String(auth.userId ?? "").trim();
  if (!authUserId) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  const listPath = "/api/task-bundle-drafts";
  if (req.method === "GET" && pathname === listPath) {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }
    const drafts = listTaskBundleDrafts({ authUserId, workspaceRoot: taskCtx.workspaceRoot });
    sendJson(res, 200, { workspaceRoot: taskCtx.workspaceRoot, drafts });
    return true;
  }

  const updateMatch = /^\/api\/task-bundle-drafts\/([^/]+)$/.exec(pathname);
  if (updateMatch && req.method === "PATCH") {
    const draftId = getDraftIdOrSendBadRequest(updateMatch[1], res);
    if (!draftId) {
      return true;
    }

    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }

    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) {
      return true;
    }
    const parsed = updateTaskBundleDraftSchema.safeParse(bodyResult.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const bundleParsed = taskBundleSchema.safeParse(parsed.data.bundle);
    if (!bundleParsed.success) {
      sendJson(res, 400, { error: "Invalid task bundle schema" });
      return true;
    }

    const existing = getDraftForWorkspaceOrSendError({
      authUserId,
      draftId,
      workspaceRoot: taskCtx.workspaceRoot,
      res,
    });
    if (!existing) {
      return true;
    }
    if (existing.status !== "draft") {
      sendJson(res, 409, { error: `Draft not editable in status: ${existing.status}` });
      return true;
    }

    const updated = updateTaskBundleDraft({ authUserId, draftId, bundle: bundleParsed.data });
    if (!updated) {
      sendJson(res, 400, { error: "Failed to update draft" });
      return true;
    }
    sendJson(res, 200, { success: true, draft: updated });
    return true;
  }

  const deleteMatch = /^\/api\/task-bundle-drafts\/([^/]+)$/.exec(pathname);
  if (deleteMatch && req.method === "DELETE") {
    const draftId = getDraftIdOrSendBadRequest(deleteMatch[1], res);
    if (!draftId) {
      return true;
    }

    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }

    const existing = getDraftForWorkspaceOrSendError({
      authUserId,
      draftId,
      workspaceRoot: taskCtx.workspaceRoot,
      res,
    });
    if (!existing) {
      return true;
    }

    const outcome = deleteTaskBundleDraft({ authUserId, draftId });
    sendJson(res, 200, { success: outcome.ok });
    return true;
  }

  const approveMatch = /^\/api\/task-bundle-drafts\/([^/]+)\/approve$/.exec(pathname);
  if (approveMatch && req.method === "POST") {
    const draftId = getDraftIdOrSendBadRequest(approveMatch[1], res);
    if (!draftId) {
      return true;
    }

    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }

    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) {
      return true;
    }
    const parsed = approveTaskBundleDraftSchema.safeParse(bodyResult.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const runQueue = Boolean(parsed.data.runQueue);

    const existing = getDraftForWorkspaceOrSendError({
      authUserId,
      draftId,
      workspaceRoot: taskCtx.workspaceRoot,
      res,
    });
    if (!existing) {
      return true;
    }

    if (existing.status === "approved") {
      sendJson(res, 200, { success: true, createdTaskIds: existing.approvedTaskIds, draft: existing });
      return true;
    }
    if (existing.status !== "draft") {
      sendJson(res, 409, { error: `Draft not approvable in status: ${existing.status}` });
      return true;
    }
    if (!existing.bundle) {
      sendJson(res, 400, { error: "Draft bundle is not available" });
      return true;
    }

    if (runQueue && !deps.taskQueueAvailable) {
      sendJson(res, 409, { error: "Task queue disabled" });
      return true;
    }

    const now = Date.now();
    const bundle: TaskBundle = existing.bundle;
    const specValidation = validateTaskBundleSpec({
      bundle,
      workspaceRoot: taskCtx.workspaceRoot,
      requireFiles: true,
    });
    if (!specValidation.ok) {
      try {
        setTaskBundleDraftError({ authUserId, draftId, error: specValidation.error, now });
      } catch {
        // ignore
      }
      sendJson(res, 400, { error: specValidation.error });
      return true;
    }
    let approvedDraft = existing;
    let ownedApproval = false;

    try {
      const { createdTaskIds } = materializeTaskBundleTasks({
        draftId,
        tasks: bundle.tasks,
        now,
        taskStore: taskCtx.taskStore,
        attachmentStore: taskCtx.attachmentStore,
        metrics: taskCtx.metrics,
        metricReason: "planner_draft",
        buildAttachmentUrl: (attachmentId) => deps.buildAttachmentRawUrl(url, attachmentId),
        onTaskMaterialized: ({ task }) => {
          deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: now });
          try {
            upsertTaskNotificationBinding({
              authUserId,
              workspaceRoot: taskCtx.workspaceRoot,
              taskId: task.id,
              taskTitle: task.title,
              now,
              logger: deps.logger,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`[Web][TaskNotifications] upsert binding failed taskId=${task.id} err=${message}`);
          }
        },
      });

      const approved = approveTaskBundleDraft({ authUserId, draftId, approvedTaskIds: createdTaskIds, now });
      if (approved) {
        approvedDraft = approved;
        ownedApproval = true;
      } else {
        const raced = getTaskBundleDraft({ authUserId, draftId });
        if (!raced) {
          sendJson(res, 404, { error: "Not Found" });
          return true;
        }
        if (raced.status !== "approved") {
          sendJson(res, 409, { error: `Draft not approvable in status: ${raced.status}` });
          return true;
        }
        approvedDraft = raced;
        ownedApproval = false;
      }

      maybePromoteApprovedDraftTasks({ deps, taskCtx, draftId, runQueue, ownedApproval });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        setTaskBundleDraftError({ authUserId, draftId, error: message });
      } catch {
        // ignore
      }
      sendJson(res, 400, { error: message });
      return true;
    }

    sendJson(res, 200, { success: true, createdTaskIds: approvedDraft.approvedTaskIds, draft: approvedDraft });
    return true;
  }

  return false;
}

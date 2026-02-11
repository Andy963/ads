import { z } from "zod";

import { recordTaskQueueMetric } from "../../taskQueue/manager.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

import { taskBundleSchema, type TaskBundle } from "../../planner/taskBundle.js";
import {
  approveTaskBundleDraft,
  deleteTaskBundleDraft,
  getTaskBundleDraft,
  listTaskBundleDrafts,
  setTaskBundleDraftError,
  updateTaskBundleDraft,
} from "../../planner/taskBundleDraftStore.js";
import { upsertTaskNotificationBinding } from "../../../taskNotifications/store.js";
import {
  normalizeCreateTaskInput,
} from "../../planner/taskBundleApprover.js";

export async function handleTaskBundleDraftRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url, auth } = ctx;
  const authUserId = String(auth.userId ?? "").trim();
  if (!authUserId) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  const listPath = "/api/task-bundle-drafts";
  if (req.method === "GET" && pathname === listPath) {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const drafts = listTaskBundleDrafts({ authUserId, workspaceRoot: taskCtx.workspaceRoot });
    sendJson(res, 200, { workspaceRoot: taskCtx.workspaceRoot, drafts });
    return true;
  }

  const updateMatch = /^\/api\/task-bundle-drafts\/([^/]+)$/.exec(pathname);
  if (updateMatch && req.method === "PATCH") {
    const draftId = String(updateMatch[1] ?? "").trim();
    if (!draftId) {
      sendJson(res, 400, { error: "draftId is required" });
      return true;
    }

    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const schema = z.object({ bundle: z.unknown() }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const bundleParsed = taskBundleSchema.safeParse(parsed.data.bundle);
    if (!bundleParsed.success) {
      sendJson(res, 400, { error: "Invalid task bundle schema" });
      return true;
    }

    const existing = getTaskBundleDraft({ authUserId, draftId });
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (existing.workspaceRoot !== taskCtx.workspaceRoot) {
      sendJson(res, 409, { error: "Draft workspace mismatch" });
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
    const draftId = String(deleteMatch[1] ?? "").trim();
    if (!draftId) {
      sendJson(res, 400, { error: "draftId is required" });
      return true;
    }

    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    const existing = getTaskBundleDraft({ authUserId, draftId });
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (existing.workspaceRoot !== taskCtx.workspaceRoot) {
      sendJson(res, 409, { error: "Draft workspace mismatch" });
      return true;
    }

    const outcome = deleteTaskBundleDraft({ authUserId, draftId });
    sendJson(res, 200, { success: outcome.ok });
    return true;
  }

  const approveMatch = /^\/api\/task-bundle-drafts\/([^/]+)\/approve$/.exec(pathname);
  if (approveMatch && req.method === "POST") {
    const draftId = String(approveMatch[1] ?? "").trim();
    if (!draftId) {
      sendJson(res, 400, { error: "draftId is required" });
      return true;
    }

    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const schema = z.object({ runQueue: z.boolean().optional() }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const runQueue = Boolean(parsed.data.runQueue);

    const existing = getTaskBundleDraft({ authUserId, draftId });
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (existing.workspaceRoot !== taskCtx.workspaceRoot) {
      sendJson(res, 409, { error: "Draft workspace mismatch" });
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
    const createdTaskIds: string[] = [];

    try {
      await taskCtx.lock.runExclusive(async () => {
        for (let i = 0; i < bundle.tasks.length; i++) {
          const specTask = bundle.tasks[i]!;
          const input = normalizeCreateTaskInput(draftId, specTask, i);
          const attachmentIds = (input.attachments ?? []).slice();
          const { attachments: _attachments, ...createInput } = input;

          let created;
          try {
            created = taskCtx.taskStore.createTask(createInput, now, { status: "queued" });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const existingTask = taskCtx.taskStore.getTask(input.id);
            if (existingTask) {
              created = existingTask;
            } else {
              throw new Error(`Create task failed (idx=${i + 1}): ${message}`);
            }
          }

          if (attachmentIds.length > 0) {
            try {
              taskCtx.attachmentStore.assignAttachmentsToTask(created.id, attachmentIds);
            } catch (error) {
              try {
                taskCtx.taskStore.deleteTask(created.id);
              } catch {
                // ignore
              }
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(`Assign attachments failed (idx=${i + 1}): ${message}`);
            }
          }

          const attachments = taskCtx.attachmentStore.listAttachmentsForTask(created.id).map((a) => ({
            id: a.id,
            url: deps.buildAttachmentRawUrl(url, a.id),
            sha256: a.sha256,
            width: a.width,
            height: a.height,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            filename: a.filename,
          }));

          recordTaskQueueMetric(taskCtx.metrics, "TASK_ADDED", { ts: now, taskId: created.id, reason: "planner_draft" });
          deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: { ...created, attachments }, ts: now });
          createdTaskIds.push(created.id);

          try {
            upsertTaskNotificationBinding({
              authUserId,
              workspaceRoot: taskCtx.workspaceRoot,
              taskId: created.id,
              taskTitle: created.title,
              now,
              logger: deps.logger,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`[Web][TaskNotifications] upsert binding failed taskId=${created.id} err=${message}`);
          }
        }

        const approved = approveTaskBundleDraft({ authUserId, draftId, approvedTaskIds: createdTaskIds, now });
        if (!approved) {
          throw new Error("Failed to mark draft as approved");
        }

        if (runQueue) {
          taskCtx.runController.setModeAll();
          taskCtx.taskQueue.resume();
          taskCtx.queueRunning = true;
          deps.promoteQueuedTasksToPending(taskCtx);
        }
      });
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

    const updated = getTaskBundleDraft({ authUserId, draftId });
    sendJson(res, 200, { success: true, createdTaskIds, draft: updated });
    return true;
  }

  return false;
}

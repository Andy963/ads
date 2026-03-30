import { z } from "zod";

import type { TaskStore as QueueTaskStore } from "../../../../tasks/store.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "../../../api/taskRun.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";

import { handleTaskChatRoute } from "./tasks/chat.js";
import { handleTaskCollectionRoutes } from "./tasks/collection.js";
import { handleTaskByIdRoute } from "./tasks/taskById.js";
import { buildTaskAttachments, readJsonBodyOrSendBadRequest, resolveTaskContextOrSendBadRequest } from "./tasks/shared.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleTaskRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (await handleTaskCollectionRoutes(ctx, deps)) {
    return true;
  }

  const retryMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);
  if (retryMatch && req.method === "POST") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const taskId = retryMatch[1] ?? "";
    const existing = taskCtx.taskStore.getTask(taskId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (existing.status !== "failed") {
      sendJson(res, 409, { error: `Task not retryable in status: ${existing.status}` });
      return true;
    }
    taskCtx.taskQueue.retry(taskId);
    const task = taskCtx.taskStore.getTask(taskId);
    if (task) {
      deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
    }
    sendJson(res, 200, { success: true, task });
    return true;
  }

  const markReviewDoneMatch = /^\/api\/tasks\/([^/]+)\/review\/mark-done$/.exec(pathname);
  if (markReviewDoneMatch && req.method === "POST") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const taskId = markReviewDoneMatch[1] ?? "";
    const existing = taskCtx.taskStore.getTask(taskId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (!existing.reviewRequired) {
      sendJson(res, 409, { error: "Task review is not enabled" });
      return true;
    }
    if (existing.status !== "completed") {
      sendJson(res, 409, { error: `Task not markable as done in status: ${existing.status}` });
      return true;
    }

    const now = Date.now();
    const existingConclusion = String(existing.reviewConclusion ?? "").trim();
    const reviewConclusion = existingConclusion || "manually marked as done";
    const reviewedAt =
      typeof existing.reviewedAt === "number" && Number.isFinite(existing.reviewedAt) && existing.reviewedAt > 0
        ? existing.reviewedAt
        : now;

    let updated = existing;
    try {
      updated = taskCtx.taskStore.updateTask(taskId, { reviewStatus: "passed", reviewConclusion, reviewedAt }, now);
    } catch (error) {
      const message = getErrorMessage(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: updated, ts: now });
    sendJson(res, 200, { success: true, task: updated });
    return true;
  }

  const runSingleTaskId = matchSingleTaskRunPath(pathname);
  if (runSingleTaskId && req.method === "POST") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const taskExists = Boolean(taskCtx.taskStore.getTask(runSingleTaskId));
    if (!taskExists) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }

    const run = async () => {
      const result = handleSingleTaskRun({
        taskQueueAvailable: deps.taskQueueAvailable,
        controller: taskCtx.runController,
        ctx: taskCtx,
        taskId: runSingleTaskId,
        now: Date.now(),
      });
      if ("task" in result && result.task) {
        deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: result.task, ts: Date.now() });
      }
      return result;
    };

    const lock = taskCtx.getLock();
    if (lock.isBusy()) {
      void lock.runExclusive(run).catch((error: unknown) => {
        const message = getErrorMessage(error);
        deps.logger.warn(`[Web][Tasks] background single-task run failed taskId=${runSingleTaskId} err=${message}`);
      });
      sendJson(res, 202, { success: true, queued: true, mode: "single", taskId: runSingleTaskId, state: "queued" });
      return true;
    }

    const result = await lock.runExclusive(run);
    sendJson(res, result.status, { ...result.body, queued: false });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks/reorder") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) return true;
    const body = bodyResult.body;
    const schema = z.object({ ids: z.array(z.string().min(1)).min(1) }).passthrough();
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const parsed = result.data;
    const ids = parsed.ids.map((id) => String(id ?? "").trim()).filter(Boolean);
    let updated: ReturnType<QueueTaskStore["reorderPendingTasks"]>;
    try {
      updated = taskCtx.taskStore.reorderPendingTasks(ids);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.toLowerCase().includes("not pending")) {
        sendJson(res, 409, { error: message });
      } else {
        sendJson(res, 400, { error: message });
      }
      return true;
    }
    const enriched = updated.map((task) => {
      const attachments = buildTaskAttachments({ taskId: task.id, url, deps, attachmentStore: taskCtx.attachmentStore });
      return { ...task, attachments };
    });

    for (const task of enriched) {
      deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
    }
    sendJson(res, 200, { success: true, tasks: enriched });
    return true;
  }

  const moveMatch = /^\/api\/tasks\/([^/]+)\/move$/.exec(pathname);
  if (moveMatch && req.method === "POST") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    if (taskCtx.queueRunning) {
      sendJson(res, 409, { error: "Task queue is running" });
      return true;
    }
    const taskId = moveMatch[1] ?? "";
    const existing = taskCtx.taskStore.getTask(taskId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (existing.status !== "pending") {
      sendJson(res, 409, { error: `Task not movable in status: ${existing.status}` });
      return true;
    }
    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) return true;
    const body = bodyResult.body;
    const schema = z.object({ direction: z.enum(["up", "down"]) }).passthrough();
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const parsed = result.data;
    const updated = taskCtx.taskStore.movePendingTask(taskId, parsed.direction);
    if (!updated) {
      sendJson(res, 200, { success: true, tasks: [] });
      return true;
    }
    for (const task of updated) {
      deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
    }
    sendJson(res, 200, { success: true, tasks: updated });
    return true;
  }

  if (await handleTaskChatRoute(ctx, deps)) {
    return true;
  }

  if (await handleTaskByIdRoute(ctx, deps)) {
    return true;
  }

  return false;
}

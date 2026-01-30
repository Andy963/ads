import crypto from "node:crypto";

import { z } from "zod";

import type { TaskStore as QueueTaskStore } from "../../../../tasks/store.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "../../../api/taskRun.js";
import { recordTaskQueueMetric } from "../../taskQueue/manager.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

import { handleTaskChatRoute } from "./tasks/chat.js";
import { handleTaskByIdRoute } from "./tasks/taskById.js";
import { parseTaskStatus } from "./tasks/shared.js";

export async function handleTaskRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method === "GET" && pathname === "/api/tasks") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const status = parseTaskStatus(url.searchParams.get("status"));
    const limitRaw = url.searchParams.get("limit")?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const tasks = taskCtx.taskStore.listTasks({ status, limit });
    const enriched = tasks.map((task) => {
      const attachments = taskCtx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
        id: a.id,
        url: deps.buildAttachmentRawUrl(url, a.id),
        sha256: a.sha256,
        width: a.width,
        height: a.height,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        filename: a.filename,
      }));
      return { ...task, attachments };
    });
    sendJson(res, 200, enriched);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const body = await readJsonBody(req);
    const schema = z
      .object({
        title: z.string().min(1).optional(),
        prompt: z.string().min(1),
        model: z.string().optional(),
        priority: z.number().optional(),
        inheritContext: z.boolean().optional(),
        maxRetries: z.number().optional(),
        attachments: z.array(z.string().min(1)).optional(),
      })
      .passthrough();
    const parsed = schema.parse(body ?? {});
    const now = Date.now();
    const attachmentIds = (parsed.attachments ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
    const taskId = crypto.randomUUID();
    let task: ReturnType<QueueTaskStore["createTask"]>;
    try {
      task = taskCtx.taskStore.createTask(
        {
          id: taskId,
          title: parsed.title,
          prompt: parsed.prompt,
          model: parsed.model,
          priority: parsed.priority,
          inheritContext: parsed.inheritContext,
          maxRetries: parsed.maxRetries,
          createdBy: "web",
        },
        now,
        undefined,
      );

      if (attachmentIds.length > 0) {
        taskCtx.attachmentStore.assignAttachmentsToTask(task.id, attachmentIds);
      }
    } catch (error) {
      try {
        taskCtx.taskStore.deleteTask(taskId);
      } catch {
        // ignore rollback errors
      }
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const statusCode =
        lower.includes("already assigned") || lower.includes("conflict") ? 409 : lower.includes("not found") ? 400 : 400;
      sendJson(res, statusCode, { error: message });
      return true;
    }

    const attachments = taskCtx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
      id: a.id,
      url: deps.buildAttachmentRawUrl(url, a.id),
      sha256: a.sha256,
      width: a.width,
      height: a.height,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      filename: a.filename,
    }));

    recordTaskQueueMetric(taskCtx.metrics, "TASK_ADDED", { ts: now, taskId: task.id });
    if (taskCtx.queueRunning) {
      taskCtx.taskQueue.notifyNewTask();
    }
    deps.broadcastToSession(taskCtx.sessionId, {
      type: "task:event",
      event: "task:updated",
      data: { ...task, attachments },
      ts: now,
    });
    sendJson(res, 201, { ...task, attachments });
    return true;
  }

  const retryMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);
  if (retryMatch && req.method === "POST") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const taskId = retryMatch[1] ?? "";
    taskCtx.taskQueue.retry(taskId);
    const task = taskCtx.taskStore.getTask(taskId);
    if (task) {
      deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
    }
    sendJson(res, 200, { success: true, task });
    return true;
  }

  const runSingleTaskId = matchSingleTaskRunPath(pathname);
  if (runSingleTaskId && req.method === "POST") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const now = Date.now();
    const result = handleSingleTaskRun({
      taskQueueAvailable: deps.taskQueueAvailable,
      controller: taskCtx.runController,
      ctx: taskCtx,
      taskId: runSingleTaskId,
      now,
    });

    if ("task" in result && result.task) {
      deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: result.task, ts: now });
    }
    sendJson(res, result.status, result.body);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks/reorder") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const body = await readJsonBody(req);
    const schema = z.object({ ids: z.array(z.string().min(1)).min(1) }).passthrough();
    const parsed = schema.parse(body ?? {});
    const ids = parsed.ids.map((id) => String(id ?? "").trim()).filter(Boolean);
    let updated: ReturnType<QueueTaskStore["reorderPendingTasks"]>;
    try {
      updated = taskCtx.taskStore.reorderPendingTasks(ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const enriched = updated.map((task) => {
      const attachments = taskCtx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
        id: a.id,
        url: deps.buildAttachmentRawUrl(url, a.id),
        sha256: a.sha256,
        width: a.width,
        height: a.height,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        filename: a.filename,
      }));
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
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    if (taskCtx.queueRunning) {
      sendJson(res, 409, { error: "Task queue is running" });
      return true;
    }
    const taskId = moveMatch[1] ?? "";
    const body = await readJsonBody(req);
    const schema = z.object({ direction: z.enum(["up", "down"]) }).passthrough();
    const parsed = schema.parse(body ?? {});
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

  const planMatch = /^\/api\/tasks\/([^/]+)\/plan$/.exec(pathname);
  if (planMatch && req.method === "GET") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const taskId = planMatch[1] ?? "";
    const task = taskCtx.taskStore.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    sendJson(res, 200, taskCtx.taskStore.getPlan(taskId));
    return true;
  }

  if (await handleTaskByIdRoute(ctx, deps)) {
    return true;
  }

  return false;
}

import { z } from "zod";

import type { ApiRouteContext, ApiSharedDeps } from "../../types.js";
import { readJsonBody, sendJson } from "../../../http.js";
import { notifyTaskTerminalViaTelegram } from "../../../../taskNotifications/telegramNotifier.js";

export async function handleTaskByIdRoute(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (!taskMatch) {
    return false;
  }

  let taskCtx;
  try {
    taskCtx = deps.resolveTaskContext(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { error: message });
    return true;
  }
  const taskId = taskMatch[1] ?? "";

  if (req.method === "GET") {
    const task = taskCtx.taskStore.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Not Found" });
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
    sendJson(res, 200, {
      ...task,
      attachments,
      messages: taskCtx.taskStore.getMessages(taskId),
    });
    return true;
  }

  if (req.method === "DELETE") {
    const task = taskCtx.taskStore.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (task.status === "running" || task.status === "planning") {
      sendJson(res, 409, { error: `Task not deletable in status: ${task.status}` });
      return true;
    }

    taskCtx.taskStore.deleteTask(taskId);
    deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:deleted", data: { taskId }, ts: Date.now() });
    sendJson(res, 200, { success: true });
    return true;
  }

  if (req.method === "PATCH") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const action =
      typeof (body as { action?: unknown } | null)?.action === "string" ? String((body as { action: string }).action) : "";
    if (action) {
      const schema = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).passthrough();
      const result = schema.safeParse(body ?? {});
      if (!result.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      const parsed = result.data;
      if (parsed.action === "pause") {
        taskCtx.taskQueue.pause("api");
        taskCtx.queueRunning = false;
        taskCtx.runController.setModeManual();
      } else if (parsed.action === "resume") {
        taskCtx.taskQueue.resume();
        taskCtx.queueRunning = true;
        taskCtx.runController.setModeAll();
      } else if (parsed.action === "cancel") {
        taskCtx.taskQueue.cancel(taskId);
        const task = taskCtx.taskStore.getTask(taskId);
        if (task) {
          deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:cancelled", data: task, ts: Date.now() });
          try {
            notifyTaskTerminalViaTelegram({ logger: deps.logger, workspaceRoot: taskCtx.workspaceRoot, task, terminalStatus: "cancelled" });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`[Web][TaskNotifications] terminal notify hook failed taskId=${task.id} err=${message}`);
          }
        }
        sendJson(res, 200, { success: true, task });
        return true;
      }
      sendJson(res, 200, { success: true });
      return true;
    }

    const updateSchema = z
      .object({
        title: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        priority: z.number().finite().optional(),
        inheritContext: z.boolean().optional(),
        maxRetries: z.number().int().min(0).optional(),
      })
      .passthrough();
    const updateResult = updateSchema.safeParse(body ?? {});
    if (!updateResult.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const parsed = updateResult.data;
    const keys = Object.keys(parsed).filter((k) => ["title", "prompt", "model", "priority", "inheritContext", "maxRetries"].includes(k));
    if (keys.length === 0) {
      sendJson(res, 400, { error: "No updates provided" });
      return true;
    }

    const existing = taskCtx.taskStore.getTask(taskId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (existing.status !== "pending" && existing.status !== "queued" && existing.status !== "cancelled") {
      sendJson(res, 409, { error: `Task not editable in status: ${existing.status}` });
      return true;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.title !== undefined) updates.title = parsed.title;
    if (parsed.prompt !== undefined) updates.prompt = parsed.prompt;
    if (parsed.model !== undefined) updates.model = parsed.model;
    if (parsed.priority !== undefined) updates.priority = parsed.priority;
    if (parsed.inheritContext !== undefined) updates.inheritContext = parsed.inheritContext;
    if (parsed.maxRetries !== undefined) updates.maxRetries = parsed.maxRetries;

    const updated = taskCtx.taskStore.updateTask(taskId, updates, Date.now());
    if (taskCtx.queueRunning) {
      taskCtx.taskQueue.notifyNewTask();
    }
    deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: updated, ts: Date.now() });
    sendJson(res, 200, { success: true, task: updated });
    return true;
  }

  return false;
}

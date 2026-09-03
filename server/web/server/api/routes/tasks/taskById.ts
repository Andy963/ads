import { z } from "zod";

import type { ApiRouteContext, ApiSharedDeps } from "../../types.js";
import type { Task } from "../../../../../tasks/types.js";
import { sendJson } from "../../../http.js";
import { notifyTaskTerminalViaTelegram } from "../../../../taskNotifications/telegramNotifier.js";
import { pauseQueueInManualMode, startQueueInAllMode } from "../../../../taskQueue/control.js";
import { buildTaskAttachments, readJsonBodyOrSendBadRequest, resolveTaskContextOrSendBadRequest } from "./shared.js";

function collectTaskChain(
  taskStore: {
    getRootTask?: (id: string) => Task | null;
    listChildTasks?: (id: string) => Task[];
  },
  task: Task,
): Task[] {
  const root = taskStore.getRootTask?.(task.id) ?? task;
  const result: Task[] = [];
  const seen = new Set<string>();
  const visit = (current: Task): void => {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    result.push(current);
    for (const child of taskStore.listChildTasks?.(current.id) ?? []) visit(child);
  };
  visit(root);
  return result;
}

export async function handleTaskByIdRoute(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (!taskMatch) {
    return false;
  }

  const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
  if (!taskCtx) return true;
  const taskId = taskMatch[1] ?? "";

  if (req.method === "GET") {
    const task = taskCtx.taskStore.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    const attachments = buildTaskAttachments({ taskId: task.id, url, deps, attachmentStore: taskCtx.attachmentStore });
    const reviewStore = taskCtx.taskStore as typeof taskCtx.taskStore & {
      getRootTask?: (id: string) => typeof task;
      listChildTasks?: (id: string) => typeof task[];
      listReviewActionAudits?: (id: string) => unknown[];
    };
    const rootTask = reviewStore.getRootTask?.(task.id) ?? task;
    const chain = collectTaskChain(reviewStore, task);
    const reviewChain = chain.map((entry) => ({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      status: entry.status,
      review: entry.review ?? null,
    }));
    sendJson(res, 200, {
      ...task,
      review: rootTask.review ?? task.review,
      rootTaskId: rootTask.id,
      reviewChain,
      reviewAudits: reviewStore.listReviewActionAudits?.(rootTask.id) ?? [],
      latestRun: taskCtx.taskStore.getLatestTaskRun(task.id),
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
    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) return true;
    const body = bodyResult.body;
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
        pauseQueueInManualMode(taskCtx, "api");
      } else if (parsed.action === "resume") {
        startQueueInAllMode(taskCtx);
        deps.promoteQueuedTasksToPending(taskCtx);
        taskCtx.runController.maybePauseAfterDrain(taskCtx);
      } else if (parsed.action === "cancel") {
        const existing = taskCtx.taskStore.getTask(taskId);
        if (!existing) {
          sendJson(res, 404, { error: "Not Found" });
          return true;
        }
        if (existing.status !== "running" && existing.status !== "planning") {
          sendJson(res, 409, { error: `Task not cancellable in status: ${existing.status}` });
          return true;
        }
        if (taskCtx.queueRunning && taskCtx.runController.getMode() === "all") {
          pauseQueueInManualMode(taskCtx, "cancel");
        }
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
        agentId: z.string().min(1).nullable().optional(),
        model: z.string().min(1).optional(),
        priority: z.number().finite().optional(),
        maxRetries: z.number().int().min(0).optional(),
        executionIsolation: z.enum(["default", "required"]).optional(),
      })
      .passthrough();
    const updateResult = updateSchema.safeParse(body ?? {});
    if (!updateResult.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const parsed = updateResult.data;
    const keys = Object.keys(parsed).filter((k) =>
      ["title", "prompt", "agentId", "model", "priority", "maxRetries", "executionIsolation"].includes(k),
    );
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
    if (parsed.agentId !== undefined) updates.agentId = parsed.agentId == null ? null : parsed.agentId.trim();
    if (parsed.model !== undefined) updates.model = parsed.model;
    if (parsed.priority !== undefined) updates.priority = parsed.priority;
    if (parsed.maxRetries !== undefined) updates.maxRetries = parsed.maxRetries;
    if (parsed.executionIsolation !== undefined) updates.executionIsolation = parsed.executionIsolation;
    updates.modelParams = existing.modelParams ?? null;

    const updated = taskCtx.taskStore.updateTask(taskId, updates, Date.now());
    if (taskCtx.queueRunning) {
      taskCtx.taskQueue.notifyNewTask();
    }
    deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: updated, ts: Date.now() });
    sendJson(res, 200, { success: true, task: { ...updated, latestRun: taskCtx.taskStore.getLatestTaskRun(updated.id) } });
    return true;
  }

  return false;
}

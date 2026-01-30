import crypto from "node:crypto";

import { z } from "zod";

import type { AgentEvent } from "../../../../codex/events.js";
import type { AgentIdentifier } from "../../../../agents/types.js";
import type { TaskStore as QueueTaskStore } from "../../../../tasks/store.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "../../../api/taskRun.js";
import { recordTaskQueueMetric } from "../../taskQueue/manager.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

function parseTaskStatus(value: string | undefined | null):
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "queued":
    case "pending":
    case "planning":
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return undefined;
  }
}

function selectAgentForModel(model: string): AgentIdentifier {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (normalized.startsWith("gemini")) {
    return "gemini";
  }
  return "codex";
}

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

  const chatMatch = /^\/api\/tasks\/([^/]+)\/chat$/.exec(pathname);
  if (chatMatch && req.method === "POST") {
    if (!deps.taskQueueAvailable) {
      sendJson(res, 409, { error: "Task queue disabled" });
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
    const taskId = chatMatch[1] ?? "";
    const task = taskCtx.taskStore.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (task.status === "cancelled") {
      sendJson(res, 409, { error: "Task is cancelled" });
      return true;
    }

    const body = await readJsonBody(req);
    const schema = z.object({ content: z.string().min(1) }).passthrough();
    const parsed = schema.parse(body ?? {});
    const content = String(parsed.content ?? "").trim();
    if (!content) {
      sendJson(res, 400, { error: "Empty message" });
      return true;
    }

    try {
      taskCtx.taskStore.addMessage({
        taskId: task.id,
        planStepId: null,
        role: "user",
        content,
        messageType: "chat",
        modelUsed: null,
        tokenCount: null,
        createdAt: Date.now(),
      });
    } catch {
      // ignore
    }
    deps.broadcastToSession(taskCtx.sessionId, {
      type: "task:event",
      event: "message",
      data: { taskId: task.id, role: "user", content },
      ts: Date.now(),
    });

    void deps.taskQueueLock.runExclusive(async () => {
      const latest = taskCtx.taskStore.getTask(taskId);
      if (!latest || latest.status === "cancelled") {
        return;
      }
      const desiredModel = String(latest.model ?? "").trim() || "auto";
      const modelToUse = desiredModel === "auto" ? (process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2") : desiredModel;
      const orchestrator = taskCtx.getTaskQueueOrchestrator(latest);
      orchestrator.setModel(modelToUse);
      const agentId = selectAgentForModel(modelToUse);

      let lastRespondingText = "";
      const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
        try {
          if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
            const next = event.delta;
            let delta = next;
            if (lastRespondingText && next.startsWith(lastRespondingText)) {
              delta = next.slice(lastRespondingText.length);
            }
            if (next.length >= lastRespondingText.length) {
              lastRespondingText = next;
            }
            if (delta) {
              deps.broadcastToSession(taskCtx.sessionId, {
                type: "task:event",
                event: "message:delta",
                data: { taskId: latest.id, role: "assistant", delta, modelUsed: modelToUse, source: "chat" },
                ts: Date.now(),
              });
            }
            return;
          }
          if (event.phase === "command" && event.title === "执行命令" && event.detail) {
            const command = String(event.detail).split(" | ")[0]?.trim();
            if (command) {
              try {
                taskCtx.taskStore.addMessage({
                  taskId: latest.id,
                  planStepId: null,
                  role: "system",
                  content: `$ ${command}`,
                  messageType: "command",
                  modelUsed: null,
                  tokenCount: null,
                  createdAt: Date.now(),
                });
              } catch {
                // ignore
              }
              deps.broadcastToSession(taskCtx.sessionId, {
                type: "task:event",
                event: "command",
                data: { taskId: latest.id, command },
                ts: Date.now(),
              });
            }
          }
        } catch {
          // ignore
        }
      });

      try {
        const prompt = [
          "你是一个正在执行任务的开发助手。",
          `任务标题: ${latest.title}`,
          `任务描述: ${latest.prompt}`,
          "",
          "用户追加指令：",
          content,
        ].join("\n");

        const result = await orchestrator.invokeAgent(agentId, prompt, { streaming: true });
        const text = typeof result.response === "string" ? result.response : String(result.response ?? "");
        try {
          taskCtx.taskStore.addMessage({
            taskId: latest.id,
            planStepId: null,
            role: "assistant",
            content: text,
            messageType: "chat",
            modelUsed: modelToUse,
            tokenCount: null,
            createdAt: Date.now(),
          });
        } catch {
          // ignore
        }
        deps.broadcastToSession(taskCtx.sessionId, {
          type: "task:event",
          event: "message",
          data: { taskId: latest.id, role: "assistant", content: text },
          ts: Date.now(),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.broadcastToSession(taskCtx.sessionId, {
          type: "task:event",
          event: "message",
          data: { taskId, role: "system", content: `[Chat failed] ${msg}` },
          ts: Date.now(),
        });
      } finally {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
    });

    sendJson(res, 200, { success: true });
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

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (taskMatch) {
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
        plan: taskCtx.taskStore.getPlan(taskId),
        messages: taskCtx.taskStore.getMessages(taskId),
      });
      return true;
    }

    if (req.method === "DELETE") {
      taskCtx.taskStore.deleteTask(taskId);
      sendJson(res, 200, { success: true });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const action =
        typeof (body as { action?: unknown } | null)?.action === "string" ? String((body as { action: string }).action) : "";
      if (action) {
        const schema = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).passthrough();
        const parsed = schema.parse(body ?? {});
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
      const parsed = updateSchema.parse(body ?? {});
      const keys = Object.keys(parsed).filter((k) =>
        ["title", "prompt", "model", "priority", "inheritContext", "maxRetries"].includes(k),
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
      if (existing.status !== "pending") {
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
  }

  return false;
}


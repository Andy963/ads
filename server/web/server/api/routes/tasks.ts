import crypto from "node:crypto";

import { z } from "zod";

import type { TaskStore as QueueTaskStore } from "../../../../tasks/store.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "../../../api/taskRun.js";
import { recordTaskQueueMetric } from "../../taskQueue/manager.js";
import { upsertTaskNotificationBinding } from "../../../taskNotifications/store.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";

import { handleTaskChatRoute } from "./tasks/chat.js";
import { handleTaskByIdRoute } from "./tasks/taskById.js";
import { buildTaskAttachments, parseTaskStatus, readJsonBodyOrSendBadRequest, resolveTaskContextOrSendBadRequest } from "./tasks/shared.js";

type TaskRouteTaskContext = ReturnType<ApiSharedDeps["resolveTaskContext"]>;
type ExplicitReviewArtifactReference = {
  reviewArtifactId: string;
  snapshotId: string;
  taskId: string;
  verdict: string;
  scope: string;
  summaryText: string;
  responseText: string;
};

const executionSchema = z
  .object({
    isolation: z.enum(["default", "required"]).optional(),
  })
  .passthrough()
  .optional();

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCreateTaskErrorStatusCode(message: string): number {
  const lower = message.toLowerCase();
  if (lower.includes("already assigned") || lower.includes("conflict")) {
    return 409;
  }
  return 400;
}

function broadcastTaskUpdated(
  deps: ApiSharedDeps,
  taskCtx: TaskRouteTaskContext,
  task: unknown,
  now: number,
): void {
  deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: now });
}

function enrichTask(taskCtx: TaskRouteTaskContext, task: ReturnType<QueueTaskStore["getTask"]>, url: URL, deps: ApiSharedDeps) {
  if (!task) {
    return null;
  }
  return {
    ...task,
    latestRun: taskCtx.taskStore.getLatestTaskRun(task.id),
    attachments: buildTaskAttachments({ taskId: task.id, url, deps, attachmentStore: taskCtx.attachmentStore }),
  };
}

function upsertTaskNotificationBindingSafe(args: {
  deps: ApiSharedDeps;
  taskCtx: TaskRouteTaskContext;
  authUserId: string;
  taskId: string;
  taskTitle: string;
  now: number;
}): void {
  const { deps, taskCtx, authUserId, taskId, taskTitle, now } = args;
  try {
    upsertTaskNotificationBinding({
      authUserId,
      workspaceRoot: taskCtx.workspaceRoot,
      taskId,
      taskTitle,
      now,
      logger: deps.logger,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    deps.logger.warn(`[Web][TaskNotifications] upsert binding failed taskId=${taskId} err=${message}`);
  }
}

function maybePromoteQueuedTasks(args: {
  deps: ApiSharedDeps;
  taskCtx: TaskRouteTaskContext;
  taskId: string;
  reason: "create" | "rerun";
}): void {
  const { deps, taskCtx, taskId, reason } = args;
  if (!taskCtx.queueRunning) {
    return;
  }
  if (taskCtx.runController.getMode() !== "all") {
    return;
  }
  try {
    deps.promoteQueuedTasksToPending(taskCtx);
  } catch (error) {
    const message = getErrorMessage(error);
    deps.logger.warn(`[Web][TaskQueue] promote queued tasks after ${reason} failed taskId=${taskId} err=${message}`);
  }
}

function resolveExplicitReviewArtifactReference(args: {
  taskCtx: TaskRouteTaskContext;
  reviewArtifactId?: string | null;
  reviewSnapshotId?: string | null;
}): { ok: true; reference: ExplicitReviewArtifactReference | null } | { ok: false; error: string } {
  const reviewArtifactId = String(args.reviewArtifactId ?? "").trim();
  const reviewSnapshotId = String(args.reviewSnapshotId ?? "").trim();
  if (!reviewArtifactId && !reviewSnapshotId) {
    return { ok: true, reference: null };
  }
  if (!reviewArtifactId) {
    return { ok: false, error: "reviewArtifactId is required when reviewSnapshotId is provided" };
  }
  const artifact = args.taskCtx.reviewStore.getArtifact(reviewArtifactId);
  if (!artifact) {
    return { ok: false, error: `Unknown review artifact: ${reviewArtifactId}` };
  }
  if (reviewSnapshotId && artifact.snapshotId !== reviewSnapshotId) {
    return {
      ok: false,
      error: `Review artifact ${reviewArtifactId} is linked to snapshot ${artifact.snapshotId}, not ${reviewSnapshotId}`,
    };
  }
  return {
    ok: true,
    reference: {
      reviewArtifactId: artifact.id,
      snapshotId: artifact.snapshotId,
      taskId: artifact.taskId,
      verdict: artifact.verdict,
      scope: artifact.scope,
      summaryText: artifact.summaryText,
      responseText: artifact.responseText,
    },
  };
}

function persistExplicitReviewArtifactReference(
  taskCtx: TaskRouteTaskContext,
  taskId: string,
  reference: ExplicitReviewArtifactReference | null,
  now: number,
): void {
  if (!reference) {
    return;
  }
  taskCtx.taskStore.saveContext(
    taskId,
    {
      contextType: "artifact:review_artifact_reference",
      content: JSON.stringify(reference),
      createdAt: now,
    },
    now,
  );
}

export async function handleTaskRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url, auth } = ctx;

  if (req.method === "GET" && pathname === "/api/tasks") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const status = parseTaskStatus(url.searchParams.get("status"));
    const limitRaw = url.searchParams.get("limit")?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const includeArchived = (() => {
      const raw = String(url.searchParams.get("includeArchived") ?? "").trim().toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes";
    })();
    const tasks = taskCtx.taskStore.listTasks({ status, limit }).filter((t) => includeArchived || t.archivedAt == null);
    const enriched = tasks.map((task) => enrichTask(taskCtx, task, url, deps)).filter(Boolean);
    sendJson(res, 200, enriched);

    // Schedule maintenance asynchronously; never block the response path.
    if (deps.scheduleWorkspacePurge) {
      res.once("finish", () => {
        setImmediate(() => {
          try {
            deps.scheduleWorkspacePurge?.(taskCtx);
          } catch {
            // ignore
          }
        });
      });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) return true;
    const body = bodyResult.body;
    const bootstrapSchema = z.object({
      enabled: z.boolean(),
      projectRef: z.string().min(1),
      maxIterations: z.number().min(1).max(10).optional(),
    }).optional();
    const schema = z
      .object({
        title: z.string().min(1).optional(),
        prompt: z.string().min(1),
        agentId: z.string().min(1).nullable().optional(),
        model: z.string().optional(),
        priority: z.number().optional(),
        maxRetries: z.number().optional(),
        reviewRequired: z.boolean().optional(),
        reviewArtifactId: z.string().min(1).optional(),
        reviewSnapshotId: z.string().min(1).optional(),
        execution: executionSchema,
        attachments: z.array(z.string().min(1)).optional(),
        bootstrap: bootstrapSchema,
      })
      .passthrough();
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const parsed = result.data;
    const now = Date.now();
    const attachmentIds = (parsed.attachments ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
    const taskId = crypto.randomUUID();
    const reviewArtifactRef = resolveExplicitReviewArtifactReference({
      taskCtx,
      reviewArtifactId: parsed.reviewArtifactId,
      reviewSnapshotId: parsed.reviewSnapshotId,
    });
    if (!reviewArtifactRef.ok) {
      sendJson(res, 400, { error: reviewArtifactRef.error });
      return true;
    }

    const modelParams: Record<string, unknown> | null =
      parsed.bootstrap?.enabled ? { bootstrap: parsed.bootstrap } : null;

    let task: ReturnType<QueueTaskStore["createTask"]>;
    try {
      task = taskCtx.taskStore.createTask(
        {
          id: taskId,
          title: parsed.title,
          prompt: parsed.prompt,
          agentId: parsed.agentId == null ? null : parsed.agentId.trim(),
          model: parsed.model,
          modelParams,
          priority: parsed.priority,
          maxRetries: parsed.maxRetries,
          executionIsolation: parsed.execution?.isolation,
          reviewRequired: parsed.reviewRequired,
          createdBy: "web",
        },
        now,
        { status: "queued" },
      );

      if (attachmentIds.length > 0) {
        taskCtx.attachmentStore.assignAttachmentsToTask(task.id, attachmentIds);
      }
      persistExplicitReviewArtifactReference(taskCtx, task.id, reviewArtifactRef.reference, now);
    } catch (error) {
      try {
        taskCtx.taskStore.deleteTask(taskId);
      } catch {
        // ignore rollback errors
      }
      const message = getErrorMessage(error);
      const statusCode = resolveCreateTaskErrorStatusCode(message);
      sendJson(res, statusCode, { error: message });
      return true;
    }

    recordTaskQueueMetric(taskCtx.metrics, "TASK_ADDED", { ts: now, taskId: task.id });
    const responseTask = enrichTask(taskCtx, task, url, deps);
    broadcastTaskUpdated(deps, taskCtx, responseTask, now);

    upsertTaskNotificationBindingSafe({
      deps,
      taskCtx,
      authUserId: auth.userId,
      taskId: task.id,
      taskTitle: task.title,
      now,
    });

    sendJson(res, 201, responseTask);

    maybePromoteQueuedTasks({ deps, taskCtx, taskId: task.id, reason: "create" });
    return true;
  }

  const rerunMatch = /^\/api\/tasks\/([^/]+)\/rerun$/.exec(pathname);
  if (rerunMatch && req.method === "POST") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const taskId = rerunMatch[1] ?? "";
    const source = taskCtx.taskStore.getTask(taskId);
    if (!source) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    if (!["completed", "failed", "cancelled"].includes(source.status)) {
      sendJson(res, 409, { error: `Task not rerunnable in status: ${source.status}` });
      return true;
    }

    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) return true;
    const body = bodyResult.body;
    const bootstrapSchema = z
      .object({
        enabled: z.literal(true),
        projectRef: z.string().trim().min(1),
        maxIterations: z.number().int().min(1).max(10).optional(),
      })
      .nullable()
      .optional();
    const schema = z
      .object({
        title: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        priority: z.number().finite().optional(),
        inheritContext: z.boolean().optional(),
        maxRetries: z.number().int().min(0).optional(),
        reviewRequired: z.boolean().optional(),
        reviewArtifactId: z.string().min(1).optional(),
        reviewSnapshotId: z.string().min(1).optional(),
        execution: executionSchema,
        bootstrap: bootstrapSchema,
      })
      .passthrough();
    const result = schema.safeParse(body ?? {});
    if (!result.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const parsed = result.data;

    const now = Date.now();
    const newId = crypto.randomUUID();
    const title = parsed.title ?? source.title;
    const prompt = parsed.prompt ?? source.prompt;
    const model = parsed.model ?? source.model;
    const priority = parsed.priority ?? source.priority;
    const inheritContext = parsed.inheritContext ?? source.inheritContext;
    const maxRetries = parsed.maxRetries ?? source.maxRetries;
    const executionIsolation = parsed.execution?.isolation ?? source.executionIsolation ?? "default";
    const reviewRequired = parsed.reviewRequired ?? source.reviewRequired;
    const reviewArtifactRef = resolveExplicitReviewArtifactReference({
      taskCtx,
      reviewArtifactId: parsed.reviewArtifactId,
      reviewSnapshotId: parsed.reviewSnapshotId,
    });
    if (!reviewArtifactRef.ok) {
      sendJson(res, 400, { error: reviewArtifactRef.error });
      return true;
    }
    const modelParams = (() => {
      const base = (() => {
        const raw = source.modelParams;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return null;
        }
        return { ...(raw as Record<string, unknown>) };
      })();
      if (parsed.bootstrap === undefined) {
        return base;
      }
      const next = { ...(base ?? {}) };
      if (parsed.bootstrap === null) {
        delete next.bootstrap;
        return Object.keys(next).length > 0 ? next : null;
      }
      return { ...next, bootstrap: parsed.bootstrap };
    })();

    let created: ReturnType<QueueTaskStore["createTask"]>;
    try {
      created = taskCtx.taskStore.createTask(
        {
          id: newId,
          title,
          prompt,
          model,
          modelParams,
          priority,
          inheritContext,
          parentTaskId: source.id,
          maxRetries,
          executionIsolation,
          reviewRequired,
          createdBy: "web",
        },
        now,
        { status: "queued" },
      );
    } catch (error) {
      const message = getErrorMessage(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    try {
      persistExplicitReviewArtifactReference(taskCtx, created.id, reviewArtifactRef.reference, now);
    } catch (error) {
      try {
        taskCtx.taskStore.deleteTask(created.id);
      } catch {
        // ignore
      }
      const message = getErrorMessage(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    try {
      const contexts = taskCtx.taskStore.getContext(source.id);
      const latestPatch = [...contexts].reverse().find((c) => c.contextType === "artifact:workspace_patch") ?? null;
      if (latestPatch) {
        taskCtx.taskStore.saveContext(
          created.id,
          { contextType: "artifact:previous_workspace_patch", content: latestPatch.content, createdAt: now },
          now,
        );
      }
    } catch {
      // ignore
    }

    recordTaskQueueMetric(taskCtx.metrics, "TASK_ADDED", { ts: now, taskId: created.id, reason: `rerun_from:${source.id}` });

    const responseTask = enrichTask(taskCtx, created, url, deps);
    broadcastTaskUpdated(deps, taskCtx, responseTask, now);

    upsertTaskNotificationBindingSafe({
      deps,
      taskCtx,
      authUserId: auth.userId,
      taskId: created.id,
      taskTitle: created.title,
      now,
    });

    sendJson(res, 201, { success: true, sourceTaskId: source.id, task: responseTask });

    maybePromoteQueuedTasks({ deps, taskCtx, taskId: created.id, reason: "rerun" });
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

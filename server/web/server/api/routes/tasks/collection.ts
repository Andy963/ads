import crypto from "node:crypto";

import { z } from "zod";

import type { TaskStore as QueueTaskStore } from "../../../../../tasks/store.js";
import { recordTaskQueueMetric } from "../../../taskQueue/manager.js";
import { upsertTaskNotificationBinding } from "../../../../taskNotifications/store.js";

import type { ApiRouteContext, ApiSharedDeps } from "../../../api/types.js";
import { sendJson } from "../../../http.js";

import {
  buildTaskAttachments,
  parseTaskStatus,
  readJsonBodyOrSendBadRequest,
  resolveTaskContextOrSendBadRequest,
} from "./shared.js";

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

function enrichTask(
  taskCtx: TaskRouteTaskContext,
  task: ReturnType<QueueTaskStore["getTask"]>,
  url: URL,
  deps: ApiSharedDeps,
) {
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
  if (!taskCtx.queueRunning || taskCtx.runController.getMode() !== "all") {
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

export async function handleTaskCollectionRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
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
    const tasks = taskCtx.taskStore.listTasks({ status, limit }).filter((task) => includeArchived || task.archivedAt == null);
    const enriched = tasks.map((task) => enrichTask(taskCtx, task, url, deps)).filter(Boolean);
    sendJson(res, 200, enriched);

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
      sendJson(res, resolveCreateTaskErrorStatusCode(message), { error: message });
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
          title: parsed.title ?? source.title,
          prompt: parsed.prompt ?? source.prompt,
          model: parsed.model ?? source.model,
          modelParams,
          priority: parsed.priority ?? source.priority,
          inheritContext: parsed.inheritContext ?? source.inheritContext,
          parentTaskId: source.id,
          maxRetries: parsed.maxRetries ?? source.maxRetries,
          executionIsolation: parsed.execution?.isolation ?? source.executionIsolation ?? "default",
          reviewRequired: parsed.reviewRequired ?? source.reviewRequired,
          createdBy: "web",
        },
        now,
        { status: "queued" },
      );
    } catch (error) {
      sendJson(res, 400, { error: getErrorMessage(error) });
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
      sendJson(res, 400, { error: getErrorMessage(error) });
      return true;
    }

    try {
      const contexts = taskCtx.taskStore.getContext(source.id);
      const latestPatch = [...contexts].reverse().find((context) => context.contextType === "artifact:workspace_patch") ?? null;
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

  return false;
}

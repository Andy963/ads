import crypto from "node:crypto";

import { z } from "zod";

import type { TaskStore as QueueTaskStore } from "../../../../tasks/store.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "../../../api/taskRun.js";

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";
import { buildReworkTaskInput, findPullRequestInTaskChain, findWorkerTaskInChain, reviewSubjectForTask } from "../../../../tasks/reviewWorkflow.js";
import type { ReviewAction, Task, TaskReviewSummary } from "../../../../tasks/types.js";
import { defaultTaskReviewSummary } from "../../../../tasks/reviewData.js";

import { handleTaskChatRoute } from "./tasks/chat.js";
import { handleTaskCollectionRoutes } from "./tasks/collection.js";
import { handleTaskByIdRoute } from "./tasks/taskById.js";
import { buildTaskAttachments, readJsonBodyOrSendBadRequest, resolveTaskContextOrSendBadRequest } from "./tasks/shared.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskChain(taskCtx: ReturnType<ApiSharedDeps["resolveTaskContext"]>, task: Task): Task[] {
  const root = taskCtx.taskStore.getRootTask(task.id) ?? task;
  const result: Task[] = [];
  const seen = new Set<string>();
  const visit = (current: Task): void => {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    result.push(current);
    for (const child of taskCtx.taskStore.listChildTasks(current.id)) visit(child);
  };
  visit(root);
  return result;
}

function cancelReviewFollowups(
  taskCtx: ReturnType<ApiSharedDeps["resolveTaskContext"]>,
  root: Task,
  now: number,
): void {
  for (const child of taskChain(taskCtx, root)) {
    if (child.id === root.id || ["completed", "failed", "cancelled"].includes(child.status)) continue;
    if (child.status === "running" || child.status === "planning") {
      taskCtx.taskQueue.cancel(child.id);
    } else {
      taskCtx.taskStore.updateTask(child.id, { status: "cancelled", error: "Review chain stopped by user" }, now);
    }
  }
}

function applyReviewToChain(
  taskCtx: ReturnType<ApiSharedDeps["resolveTaskContext"]>,
  task: Task,
  review: Partial<TaskReviewSummary>,
  now: number,
): Task[] {
  const root = taskCtx.taskStore.getRootTask(task.id) ?? task;
  const next = defaultTaskReviewSummary({ ...(root.review ?? {}), ...review, rootTaskId: root.id, required: true });
  const subject = reviewSubjectForTask(task, (id) => taskCtx.taskStore.getTask(id)) ?? task;
  const ids = [...new Set([root.id, subject.id, task.id])];
  return ids.map((id) => taskCtx.taskStore.updateTaskReview(id, next, now));
}

function broadcastReviewUpdate(
  deps: ApiSharedDeps,
  taskCtx: ReturnType<ApiSharedDeps["resolveTaskContext"]>,
  task: Task,
  review: TaskReviewSummary,
  event: string,
  message: string,
  now: number,
): void {
  deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "review:updated", data: {
    taskId: task.id,
    rootTaskId: review.rootTaskId,
    event,
    message,
    review,
  }, ts: now });
}

export async function handleTaskRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (pathname === "/api/review-settings") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    if (req.method === "GET") {
      sendJson(res, 200, taskCtx.taskStore.getReviewSettings());
      return true;
    }
    if (req.method === "PATCH") {
      const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
      if (!bodyResult.ok) return true;
      const parsed = z.object({
        automationMode: z.enum(["auto_with_fuse", "human_gated"]).optional(),
        maxReworkRounds: z.number().int().min(0).optional(),
      }).safeParse(bodyResult.body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid review settings" });
        return true;
      }
      try {
        sendJson(res, 200, taskCtx.taskStore.upsertReviewSettings(parsed.data));
      } catch (error) {
        sendJson(res, 400, { error: getErrorMessage(error) });
      }
      return true;
    }
    return false;
  }

  const reviewActionMatch = /^\/api\/tasks\/([^/]+)\/review-actions$/.exec(pathname);
  if (reviewActionMatch && req.method === "POST") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const taskId = reviewActionMatch[1] ?? "";
    const task = taskCtx.taskStore.getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    const bodyResult = await readJsonBodyOrSendBadRequest(req, res);
    if (!bodyResult.ok) return true;
    const parsed = z.object({
      action: z.enum(["force_approve", "edit_rework", "skip_review", "abort"]),
      feedback: z.string().optional(),
      reason: z.string().optional(),
      idempotencyKey: z.string().trim().min(1).optional(),
    }).safeParse(bodyResult.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid review action" });
      return true;
    }
    const action = parsed.data.action as ReviewAction;
    const reason = String(parsed.data.feedback ?? parsed.data.reason ?? "").trim();
    const idempotencyKey = parsed.data.idempotencyKey
      ?? (Array.isArray(req.headers["idempotency-key"]) ? req.headers["idempotency-key"][0] : req.headers["idempotency-key"])
      ?? `review:${taskId}:${action}:${crypto.createHash("sha256").update(reason).digest("hex").slice(0, 16)}`;
    const existingAudit = taskCtx.taskStore.getReviewActionAuditByIdempotency(String(idempotencyKey));
    if (existingAudit) {
      const current = taskCtx.taskStore.getRootTask(task.id) ?? task;
      sendJson(res, 200, { success: true, replayed: true, audit: existingAudit, task: current, rootTask: current });
      return true;
    }

    const root = taskCtx.taskStore.getRootTask(task.id) ?? task;
    const currentReview = defaultTaskReviewSummary(root.review);
    if (!currentReview.required || ["approved", "skipped"].includes(currentReview.status)) {
      sendJson(res, 409, { error: `Review action is not valid in status: ${currentReview.status}` });
      return true;
    }
    if (action === "edit_rework" && !reason) {
      sendJson(res, 400, { error: "feedback is required for edit_rework" });
      return true;
    }

    const now = Date.now();
    let rework: Task | null = null;
    try {
      if (action === "edit_rework") {
        const pullRequest = currentReview.pullRequestNumber
          ? { number: currentReview.pullRequestNumber, url: currentReview.pullRequestUrl }
          : findPullRequestInTaskChain(task, (id) => taskCtx.taskStore.getTask(id));
        if (!pullRequest) throw new Error("Cannot edit and rework without a pull request reference");
        const worker = findWorkerTaskInChain(root, (id) => taskCtx.taskStore.getTask(id));
        const reviewTask = currentReview.reviewTaskId ? taskCtx.taskStore.getTask(currentReview.reviewTaskId) : task;
        if (!reviewTask) throw new Error("Linked review task was not found");
        const existingRework = currentReview.reworkTaskIds
          .map((id) => taskCtx.taskStore.getTask(id))
          .find((candidate) => candidate && !["completed", "failed", "cancelled"].includes(candidate.status));
        if (existingRework) throw new Error("A review rework task is already active");
        cancelReviewFollowups(taskCtx, root, now);
        rework = taskCtx.taskStore.createTask(
          buildReworkTaskInput({ reviewTask, workerTask: worker, pullRequest, feedback: reason }),
          now,
          { status: "pending" },
        );
        const next = applyReviewToChain(taskCtx, task, {
          status: "rejected",
          reworkTaskIds: [...currentReview.reworkTaskIds, rework.id],
          stateReason: "Manual rework queued.",
          controlState: taskCtx.taskStore.getReviewSettings().automationMode === "human_gated" ? "human_gated" : "automatic",
          feedback: reason,
          reviewedAt: now,
        }, now)[0]?.review;
        if (next) broadcastReviewUpdate(deps, taskCtx, root, next, "human_rework", "Manual rework queued.", now);
      } else {
        const status = action === "force_approve" ? "approved" : action === "skip_review" ? "skipped" : "needs_human_intervention";
        const message = action === "force_approve" ? "Review force-approved by a user." : action === "skip_review" ? "Review skipped by a user." : "Review chain aborted by a user.";
        cancelReviewFollowups(taskCtx, root, now);
        const next = applyReviewToChain(taskCtx, task, {
          status,
          conclusion: action === "force_approve" ? "Manually approved" : currentReview.conclusion,
          stateReason: reason || message,
          controlState: "human_gated",
          reviewedAt: now,
        }, now)[0]?.review;
        if (next) broadcastReviewUpdate(deps, taskCtx, root, next, action, message, now);
      }
      const audit = taskCtx.taskStore.createReviewActionAudit({
        taskId: task.id,
        rootTaskId: root.id,
        action,
        reason: reason || null,
        actorId: ctx.auth.userId,
        idempotencyKey: String(idempotencyKey),
        now,
      });
      const updatedRoot = taskCtx.taskStore.getRootTask(root.id) ?? root;
      try {
        taskCtx.taskStore.addMessage({
          taskId: root.id,
          role: "system",
          content: `[Code Review] ${action}: ${reason || "completed"}`,
          messageType: "review_action",
          modelUsed: null,
          tokenCount: null,
          createdAt: now,
        });
      } catch {
        // The action and review state are already durable; chat persistence is best effort.
      }
      deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: updatedRoot, ts: now });
      if (rework) deps.broadcastToSession(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: rework, ts: now });
      if (rework) taskCtx.taskQueue.notifyNewTask();
      sendJson(res, 200, { success: true, audit, task: updatedRoot, rootTask: updatedRoot, reworkTask: rework });
    } catch (error) {
      sendJson(res, 409, { error: getErrorMessage(error) });
    }
    return true;
  }

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

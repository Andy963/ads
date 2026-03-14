import type { TaskQueueContext } from "../../taskQueue/manager.js";
import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";
import { pauseQueueInManualMode, startQueueInAllMode } from "../../../taskQueue/control.js";
import { resolveTaskContextOrSendBadRequest } from "./shared.js";

type TaskQueueRouteDeps = Pick<ApiSharedDeps, "taskQueueAvailable" | "resolveTaskContext" | "promoteQueuedTasksToPending">;

function ensureTaskQueueEnabled(
  ctx: Pick<ApiRouteContext, "res">,
  deps: Pick<TaskQueueRouteDeps, "taskQueueAvailable">,
): boolean {
  if (deps.taskQueueAvailable) {
    return true;
  }
  sendJson(ctx.res, 409, { error: "Task queue disabled" });
  return false;
}

function buildQueueStatusPayload(args: {
  taskCtx: TaskQueueContext;
  enabled: boolean;
  success?: boolean;
  queued?: boolean;
}): Record<string, unknown> {
  const { taskCtx, enabled, success, queued } = args;
  const payload: Record<string, unknown> = {
    enabled,
    running: taskCtx.queueRunning,
    ...taskCtx.getStatusOrchestrator().status(),
  };
  if (typeof success === "boolean") {
    payload.success = success;
  }
  if (typeof queued === "boolean") {
    payload.queued = queued;
  }
  return payload;
}

export async function handleTaskQueueRoutes(
  ctx: ApiRouteContext,
  deps: TaskQueueRouteDeps,
): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method === "GET" && pathname === "/api/task-queue/status") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }
    sendJson(res, 200, buildQueueStatusPayload({ taskCtx, enabled: deps.taskQueueAvailable }));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/task-queue/metrics") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }
    sendJson(res, 200, { workspaceRoot: taskCtx.workspaceRoot, running: taskCtx.queueRunning, ...taskCtx.metrics });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/task-queue/run") {
    if (!ensureTaskQueueEnabled({ res }, deps)) {
      return true;
    }
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }
    const action = async () => {
      startQueueInAllMode(taskCtx);
      deps.promoteQueuedTasksToPending(taskCtx);
      taskCtx.runController.maybePauseAfterDrain(taskCtx);
    };
    if (taskCtx.lock.isBusy()) {
      void taskCtx.lock.runExclusive(action);
      sendJson(res, 202, buildQueueStatusPayload({ taskCtx, enabled: deps.taskQueueAvailable, success: true, queued: true }));
      return true;
    }
    await taskCtx.lock.runExclusive(action);
    sendJson(res, 200, buildQueueStatusPayload({ taskCtx, enabled: deps.taskQueueAvailable, success: true, queued: false }));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/task-queue/pause") {
    if (!ensureTaskQueueEnabled({ res }, deps)) {
      return true;
    }
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) {
      return true;
    }
    pauseQueueInManualMode(taskCtx, "manual");
    sendJson(res, 200, buildQueueStatusPayload({ taskCtx, enabled: deps.taskQueueAvailable, success: true }));
    return true;
  }

  return false;
}

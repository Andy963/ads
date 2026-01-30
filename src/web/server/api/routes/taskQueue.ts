import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";

export async function handleTaskQueueRoutes(
  ctx: ApiRouteContext,
  deps: Pick<ApiSharedDeps, "taskQueueAvailable" | "resolveTaskContext" | "promoteQueuedTasksToPending" | "taskQueueLock">,
): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method === "GET" && pathname === "/api/task-queue/status") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    const status = taskCtx.getStatusOrchestrator().status();
    sendJson(res, 200, { enabled: deps.taskQueueAvailable, running: taskCtx.queueRunning, ...status });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/task-queue/metrics") {
    let taskCtx;
    try {
      taskCtx = deps.resolveTaskContext(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }
    sendJson(res, 200, { workspaceRoot: taskCtx.workspaceRoot, running: taskCtx.queueRunning, ...taskCtx.metrics });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/task-queue/run") {
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
    const action = async () => {
      taskCtx.runController.setModeAll();
      taskCtx.taskQueue.resume();
      taskCtx.queueRunning = true;
      deps.promoteQueuedTasksToPending(taskCtx);
    };
    if (deps.taskQueueLock.isBusy()) {
      void deps.taskQueueLock.runExclusive(action);
      const status = taskCtx.getStatusOrchestrator().status();
      sendJson(res, 202, { success: true, queued: true, enabled: deps.taskQueueAvailable, running: taskCtx.queueRunning, ...status });
      return true;
    }
    await deps.taskQueueLock.runExclusive(action);
    const status = taskCtx.getStatusOrchestrator().status();
    sendJson(res, 200, { success: true, queued: false, enabled: deps.taskQueueAvailable, running: taskCtx.queueRunning, ...status });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/task-queue/pause") {
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
    taskCtx.runController.setModeManual();
    taskCtx.taskQueue.pause("manual");
    taskCtx.queueRunning = false;
    const status = taskCtx.getStatusOrchestrator().status();
    sendJson(res, 200, { success: true, enabled: deps.taskQueueAvailable, running: taskCtx.queueRunning, ...status });
    return true;
  }

  return false;
}

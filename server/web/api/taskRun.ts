import type { Task } from "../../tasks/types.js";
import type { TaskMessage } from "../../tasks/types.js";
import type { TaskRunController, TaskRunControllerContext, SingleTaskRunResult } from "../taskRunController.js";

export function matchSingleTaskRunPath(pathname: string): string | null {
  const match = /^\/api\/tasks\/([^/]+)\/run$/.exec(pathname);
  return match?.[1] ? String(match[1]).trim() : null;
}

export type HandleSingleTaskRunResult =
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string; taskId?: string } }
  | { status: 202; body: { success: true; mode: string; taskId: string; state: "running" | "requested" }; task: Task }
  | { status: 200; body: { success: true; mode: string; taskId: string; state: "scheduled" }; task: Task; auditMessage?: TaskMessage };

export function handleSingleTaskRun(options: {
  taskQueueAvailable: boolean;
  controller: TaskRunController;
  ctx: TaskRunControllerContext;
  taskId: string;
  now?: number;
}): HandleSingleTaskRunResult {
  if (!options.taskQueueAvailable) {
    return { status: 409, body: { error: "Task queue disabled" } };
  }

  const res: SingleTaskRunResult = options.controller.requestSingleTaskRun(options.ctx, options.taskId, options.now);
  return res as HandleSingleTaskRunResult;
}


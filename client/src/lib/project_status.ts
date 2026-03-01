import type { TaskStatus } from "../api/types";

export function isTaskInProgress(status: TaskStatus): boolean {
  return status === "planning" || status === "running";
}

export function isProjectInProgress(params: {
  taskStatuses: readonly TaskStatus[];
  conversationInProgress: boolean;
}): boolean {
  if (params.conversationInProgress) return true;
  return params.taskStatuses.some(isTaskInProgress);
}

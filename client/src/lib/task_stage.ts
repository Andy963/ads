import type { Task } from "../api/types";

export type TaskStage = "backlog" | "in_progress" | "done";

export function deriveTaskStage(task: Pick<Task, "status">): TaskStage {
  const status = task.status;

  if (status === "completed") {
    return "done";
  }

  if (status === "planning" || status === "running" || status === "failed") {
    return "in_progress";
  }

  return "backlog";
}

import type { Task } from "../api/types";

export type TaskStage = "backlog" | "in_progress" | "in_review" | "done";

export function deriveTaskStage(task: Pick<Task, "status" | "reviewRequired" | "reviewStatus">): TaskStage {
  const status = task.status;

  if (status === "completed") {
    if (!task.reviewRequired) return "done";
    return task.reviewStatus === "passed" ? "done" : "in_review";
  }

  if (status === "planning" || status === "running" || status === "failed") {
    return "in_progress";
  }

  return "backlog";
}


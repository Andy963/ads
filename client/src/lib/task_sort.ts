import type { Task } from "../api/types";

type DisplayTask = Pick<Task, "status" | "priority" | "createdAt">;

export function shouldDisplayTask(task: Pick<Task, "status">): boolean {
  return task.status !== "completed";
}

export function taskStatusWeight(status: string): number {
  if (status === "planning" || status === "running") return 1;
  if (status === "completed") return 9;
  return 0;
}

export function compareTasksForDisplay(a: DisplayTask, b: DisplayTask): number {
  const wa = taskStatusWeight(a.status);
  const wb = taskStatusWeight(b.status);
  if (wa !== wb) return wa - wb;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.status !== b.status) return a.status.localeCompare(b.status);
  return 0;
}

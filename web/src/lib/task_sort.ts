import type { Task } from "../api/types";

type DisplayTask = Pick<Task, "status" | "priority" | "createdAt">;

export function taskStatusWeight(status: string): number {
  if (status === "running") return 0;
  if (status === "planning") return 1;
  if (status === "pending" || status === "queued") return 2;
  if (status === "completed") return 9;
  return 5;
}

export function compareTasksForDisplay(a: DisplayTask, b: DisplayTask): number {
  const wa = taskStatusWeight(a.status);
  const wb = taskStatusWeight(b.status);
  if (wa !== wb) return wa - wb;
  if (a.status !== b.status) return a.status.localeCompare(b.status);
  if (a.priority !== b.priority) return b.priority - a.priority;
  return b.createdAt - a.createdAt;
}

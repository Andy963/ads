import type { Task } from "../../api/types";

export function pickNextSelectedTaskId(nextTasks: Task[]): string | null {
  if (!nextTasks.length) return null;
  const nextPending = nextTasks
    .filter((t) => t.status === "pending")
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
      return a.createdAt - b.createdAt;
    })[0];
  return (nextPending ?? nextTasks[0])!.id;
}

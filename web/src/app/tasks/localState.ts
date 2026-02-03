import type { Task } from "../../api/types";
import type { ProjectRuntime } from "../controllerTypes";

function pickNextSelectedTaskId(nextTasks: Task[]): string | null {
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

export function removeTaskLocal(taskId: string, rt: ProjectRuntime): void {
  const normalized = String(taskId ?? "").trim();
  if (!normalized) return;

  const nextTasks = rt.tasks.value.filter((t) => t.id !== normalized);
  if (nextTasks.length === rt.tasks.value.length) {
    return;
  }
  rt.tasks.value = nextTasks;

  rt.expanded.value = new Set([...rt.expanded.value].filter((x) => x !== normalized));
  rt.plansByTaskId.value.delete(normalized);
  rt.plansByTaskId.value = new Map(rt.plansByTaskId.value);
  rt.planFetchInFlightByTaskId.delete(normalized);
  rt.startedTaskIds.delete(normalized);
  rt.taskChatBufferByTaskId.delete(normalized);

  if (rt.selectedId.value === normalized) {
    rt.selectedId.value = pickNextSelectedTaskId(rt.tasks.value);
  }
}

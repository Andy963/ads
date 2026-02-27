import type { ProjectRuntime } from "../controllerTypes";
import { pickNextSelectedTaskId } from "./selection";

export function removeTaskLocal(taskId: string, rt: ProjectRuntime): void {
  const normalized = String(taskId ?? "").trim();
  if (!normalized) return;

  const nextTasks = rt.tasks.value.filter((t) => t.id !== normalized);
  if (nextTasks.length === rt.tasks.value.length) {
    return;
  }
  rt.tasks.value = nextTasks;
  rt.startedTaskIds.delete(normalized);
  rt.taskChatBufferByTaskId.delete(normalized);

  if (rt.selectedId.value === normalized) {
    rt.selectedId.value = pickNextSelectedTaskId(rt.tasks.value);
  }
}

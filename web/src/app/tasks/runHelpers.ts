import type { Ref } from "vue";

import type { Task } from "../../api/types";
import type { ProjectRuntime } from "../controllerTypes";

export function createTaskRunHelpers(params: {
  activeProjectId: Ref<string>;
  normalizeProjectId: (id: string | null | undefined) => string;
  getRuntime: (projectId: string | null | undefined) => ProjectRuntime;
  upsertTask: (t: Task, rt?: ProjectRuntime) => void;
}) {
  const resolveTaskRuntime = (
    taskIdInput: string,
    projectIdInput: string,
  ): { taskId: string; rt: ProjectRuntime } | null => {
    const taskId = String(taskIdInput ?? "").trim();
    if (!taskId) {
      return null;
    }
    const pid = params.normalizeProjectId(projectIdInput);
    const rt = params.getRuntime(pid);
    return { taskId, rt };
  };

  const setTaskRunBusy = (id: string, busy: boolean, projectId: string = params.activeProjectId.value): void => {
    const resolved = resolveTaskRuntime(id, projectId);
    if (!resolved) return;
    const { taskId, rt } = resolved;
    const next = new Set(rt.runBusyIds.value);
    if (busy) next.add(taskId);
    else next.delete(taskId);
    rt.runBusyIds.value = next;
  };

  const mockSingleTaskRun = (taskId: string, projectId: string = params.activeProjectId.value): void => {
    const resolved = resolveTaskRuntime(taskId, projectId);
    if (!resolved) return;
    const { taskId: id, rt } = resolved;
    const now = Date.now();

    const existing = rt.tasks.value.find((t) => t.id === id);
    if (!existing) return;

    params.upsertTask({ ...existing, status: "running", startedAt: now, completedAt: null, error: null, result: null }, rt);
    window.setTimeout(() => {
      const t = rt.tasks.value.find((x) => x.id === id);
      if (!t) return;
      params.upsertTask({ ...t, status: "completed", completedAt: Date.now(), result: "mock: completed", error: null }, rt);
    }, 900);
  };

  return { setTaskRunBusy, mockSingleTaskRun };
}

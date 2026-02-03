import type { Ref } from "vue";

import type { Task } from "../../api/types";
import type { ProjectRuntime } from "../controllerTypes";

export function createTaskRunHelpers(params: {
  activeProjectId: Ref<string>;
  normalizeProjectId: (id: string | null | undefined) => string;
  getRuntime: (projectId: string | null | undefined) => ProjectRuntime;
  upsertTask: (t: Task, rt?: ProjectRuntime) => void;
}) {
  const setTaskRunBusy = (id: string, busy: boolean, projectId: string = params.activeProjectId.value): void => {
    const taskId = String(id ?? "").trim();
    if (!taskId) return;
    const pid = params.normalizeProjectId(projectId);
    const rt = params.getRuntime(pid);
    const next = new Set(rt.runBusyIds.value);
    if (busy) next.add(taskId);
    else next.delete(taskId);
    rt.runBusyIds.value = next;
  };

  const mockSingleTaskRun = (taskId: string, projectId: string = params.activeProjectId.value): void => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    const pid = params.normalizeProjectId(projectId);
    const rt = params.getRuntime(pid);
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


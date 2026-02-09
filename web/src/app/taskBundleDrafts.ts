import type { ApiClient } from "../api/client";
import type { TaskBundle, TaskBundleDraft } from "../api/types";

import type { ProjectRuntime } from "./controllerTypes";

type Ref<T> = { value: T };

function upsertDraftLocal(rt: ProjectRuntime, draft: TaskBundleDraft): void {
  const existing = Array.isArray(rt.taskBundleDrafts.value) ? rt.taskBundleDrafts.value : [];
  const idx = existing.findIndex((d) => d.id === draft.id);
  if (idx >= 0) {
    rt.taskBundleDrafts.value = existing.map((d, i) => (i === idx ? draft : d));
    return;
  }
  rt.taskBundleDrafts.value = [draft, ...existing];
}

function deleteDraftLocal(rt: ProjectRuntime, draftId: string): void {
  const id = String(draftId ?? "").trim();
  if (!id) return;
  const existing = Array.isArray(rt.taskBundleDrafts.value) ? rt.taskBundleDrafts.value : [];
  rt.taskBundleDrafts.value = existing.filter((d) => d.id !== id);
}

export function createTaskBundleDraftActions(deps: {
  api: ApiClient;
  loggedIn: Ref<boolean>;
  activeProjectId: Ref<string>;
  normalizeProjectId: (id: string | null | undefined) => string;
  getPlannerRuntime: (projectId: string | null | undefined) => ProjectRuntime;
  withWorkspaceQueryFor: (projectId: string, apiPath: string) => string;
}) {
  const loadTaskBundleDrafts = async (projectId: string = deps.activeProjectId.value): Promise<void> => {
    if (!deps.loggedIn.value) return;
    const pid = deps.normalizeProjectId(projectId);
    const rt = deps.getPlannerRuntime(pid);
    rt.taskBundleDraftsError.value = null;
    rt.taskBundleDraftsBusy.value = true;
    try {
      const res = await deps.api.get<{ drafts?: TaskBundleDraft[] }>(deps.withWorkspaceQueryFor(pid, "/api/task-bundle-drafts"));
      rt.taskBundleDrafts.value = Array.isArray(res?.drafts) ? res.drafts : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rt.taskBundleDraftsError.value = message;
    } finally {
      rt.taskBundleDraftsBusy.value = false;
    }
  };

  const updateTaskBundleDraft = async (draftId: string, bundle: TaskBundle, projectId: string = deps.activeProjectId.value): Promise<TaskBundleDraft | null> => {
    if (!deps.loggedIn.value) return null;
    const id = String(draftId ?? "").trim();
    if (!id) return null;
    const pid = deps.normalizeProjectId(projectId);
    const rt = deps.getPlannerRuntime(pid);
    rt.taskBundleDraftsError.value = null;
    rt.taskBundleDraftsBusy.value = true;
    try {
      const res = await deps.api.patch<{ success: boolean; draft?: TaskBundleDraft | null }>(
        deps.withWorkspaceQueryFor(pid, `/api/task-bundle-drafts/${encodeURIComponent(id)}`),
        { bundle },
      );
      const updated = res?.draft ?? null;
      if (updated && updated.id) {
        upsertDraftLocal(rt, updated);
        return updated;
      }
      await loadTaskBundleDrafts(pid);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rt.taskBundleDraftsError.value = message;
      return null;
    } finally {
      rt.taskBundleDraftsBusy.value = false;
    }
  };

  const deleteTaskBundleDraft = async (draftId: string, projectId: string = deps.activeProjectId.value): Promise<boolean> => {
    if (!deps.loggedIn.value) return false;
    const id = String(draftId ?? "").trim();
    if (!id) return false;
    const pid = deps.normalizeProjectId(projectId);
    const rt = deps.getPlannerRuntime(pid);
    rt.taskBundleDraftsError.value = null;
    rt.taskBundleDraftsBusy.value = true;
    try {
      const res = await deps.api.delete<{ success: boolean }>(deps.withWorkspaceQueryFor(pid, `/api/task-bundle-drafts/${encodeURIComponent(id)}`));
      const ok = Boolean(res?.success);
      if (ok) {
        deleteDraftLocal(rt, id);
      } else {
        await loadTaskBundleDrafts(pid);
      }
      return ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rt.taskBundleDraftsError.value = message;
      return false;
    } finally {
      rt.taskBundleDraftsBusy.value = false;
    }
  };

  const approveTaskBundleDraft = async (
    draftId: string,
    options?: { runQueue?: boolean; projectId?: string },
  ): Promise<{ ok: boolean; createdTaskIds: string[]; draft: TaskBundleDraft | null }> => {
    if (!deps.loggedIn.value) return { ok: false, createdTaskIds: [], draft: null };
    const id = String(draftId ?? "").trim();
    if (!id) return { ok: false, createdTaskIds: [], draft: null };
    const pid = deps.normalizeProjectId(options?.projectId ?? deps.activeProjectId.value);
    const rt = deps.getPlannerRuntime(pid);
    rt.taskBundleDraftsError.value = null;
    rt.taskBundleDraftsBusy.value = true;
    try {
      const res = await deps.api.post<{ success: boolean; createdTaskIds?: string[]; draft?: TaskBundleDraft | null }>(
        deps.withWorkspaceQueryFor(pid, `/api/task-bundle-drafts/${encodeURIComponent(id)}/approve`),
        { runQueue: Boolean(options?.runQueue) },
      );
      const updated = res?.draft ?? null;
      if (updated && updated.id) {
        upsertDraftLocal(rt, updated);
      } else {
        await loadTaskBundleDrafts(pid);
      }
      return { ok: Boolean(res?.success), createdTaskIds: Array.isArray(res?.createdTaskIds) ? res.createdTaskIds : [], draft: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rt.taskBundleDraftsError.value = message;
      return { ok: false, createdTaskIds: [], draft: null };
    } finally {
      rt.taskBundleDraftsBusy.value = false;
    }
  };

  return {
    loadTaskBundleDrafts,
    updateTaskBundleDraft,
    deleteTaskBundleDraft,
    approveTaskBundleDraft,
  };
}

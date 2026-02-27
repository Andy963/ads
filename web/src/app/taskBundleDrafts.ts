import type { ApiClient } from "../api/client";
import type { TaskBundle, TaskBundleDraft } from "../api/types";

import type { ProjectRuntime } from "./controllerTypes";
import { listTaskBundleDrafts, removeTaskBundleDraft, upsertTaskBundleDraft } from "./taskBundleDraftsState";

type Ref<T> = { value: T };

function normalizeDraftId(draftId: string): string {
  return String(draftId ?? "").trim();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsertDraftLocal(rt: ProjectRuntime, draft: TaskBundleDraft): void {
  const existing = listTaskBundleDrafts(rt.taskBundleDrafts.value);
  const next = upsertTaskBundleDraft(existing, draft);
  if (next !== existing) {
    rt.taskBundleDrafts.value = next;
  }
}

function deleteDraftLocal(rt: ProjectRuntime, draftId: string): void {
  const existing = listTaskBundleDrafts(rt.taskBundleDrafts.value);
  const next = removeTaskBundleDraft(existing, draftId);
  if (next !== existing) {
    rt.taskBundleDrafts.value = next;
  }
}

export function createTaskBundleDraftActions(deps: {
  api: ApiClient;
  loggedIn: Ref<boolean>;
  activeProjectId: Ref<string>;
  normalizeProjectId: (id: string | null | undefined) => string;
  getPlannerRuntime: (projectId: string | null | undefined) => ProjectRuntime;
  withWorkspaceQueryFor: (projectId: string, apiPath: string) => string;
}) {
  const resolveRuntime = (projectId: string | null | undefined): { pid: string; rt: ProjectRuntime } => {
    const pid = deps.normalizeProjectId(projectId);
    const rt = deps.getPlannerRuntime(pid);
    return { pid, rt };
  };

  const fetchTaskBundleDrafts = async (pid: string, rt: ProjectRuntime): Promise<void> => {
    const res = await deps.api.get<{ drafts?: TaskBundleDraft[] }>(deps.withWorkspaceQueryFor(pid, "/api/task-bundle-drafts"));
    rt.taskBundleDrafts.value = Array.isArray(res?.drafts) ? res.drafts : [];
  };

  const withDraftRequest = async <T>(
    projectId: string | null | undefined,
    fallback: T,
    run: (ctx: { pid: string; rt: ProjectRuntime }) => Promise<T>,
  ): Promise<T> => {
    if (!deps.loggedIn.value) return fallback;
    const { pid, rt } = resolveRuntime(projectId);
    rt.taskBundleDraftsError.value = null;
    rt.taskBundleDraftsBusy.value = true;
    try {
      return await run({ pid, rt });
    } catch (error) {
      rt.taskBundleDraftsError.value = toErrorMessage(error);
      return fallback;
    } finally {
      rt.taskBundleDraftsBusy.value = false;
    }
  };

  const emptyApproveResult = (): { ok: boolean; createdTaskIds: string[]; draft: TaskBundleDraft | null } => ({
    ok: false,
    createdTaskIds: [],
    draft: null,
  });

  const loadTaskBundleDrafts = async (projectId: string = deps.activeProjectId.value): Promise<void> => {
    await withDraftRequest(projectId, undefined, async ({ pid, rt }) => {
      await fetchTaskBundleDrafts(pid, rt);
    });
  };

  const updateTaskBundleDraft = async (
    draftId: string,
    bundle: TaskBundle,
    projectId: string = deps.activeProjectId.value,
  ): Promise<TaskBundleDraft | null> => {
    const id = normalizeDraftId(draftId);
    if (!id) return null;
    return await withDraftRequest(projectId, null, async ({ pid, rt }) => {
      const res = await deps.api.patch<{ success: boolean; draft?: TaskBundleDraft | null }>(
        deps.withWorkspaceQueryFor(pid, `/api/task-bundle-drafts/${encodeURIComponent(id)}`),
        { bundle },
      );
      const updated = res?.draft ?? null;
      if (updated && updated.id) {
        upsertDraftLocal(rt, updated);
        return updated;
      }
      await fetchTaskBundleDrafts(pid, rt);
      return null;
    });
  };

  const deleteTaskBundleDraft = async (draftId: string, projectId: string = deps.activeProjectId.value): Promise<boolean> => {
    const id = normalizeDraftId(draftId);
    if (!id) return false;
    return await withDraftRequest(projectId, false, async ({ pid, rt }) => {
      const res = await deps.api.delete<{ success: boolean }>(deps.withWorkspaceQueryFor(pid, `/api/task-bundle-drafts/${encodeURIComponent(id)}`));
      const ok = Boolean(res?.success);
      if (ok) {
        deleteDraftLocal(rt, id);
      } else {
        await fetchTaskBundleDrafts(pid, rt);
      }
      return ok;
    });
  };

  const approveTaskBundleDraft = async (
    draftId: string,
    options?: { runQueue?: boolean; projectId?: string },
  ): Promise<{ ok: boolean; createdTaskIds: string[]; draft: TaskBundleDraft | null }> => {
    const id = normalizeDraftId(draftId);
    if (!id) return emptyApproveResult();
    return await withDraftRequest(options?.projectId ?? deps.activeProjectId.value, emptyApproveResult(), async ({ pid, rt }) => {
      const res = await deps.api.post<{ success: boolean; createdTaskIds?: string[]; draft?: TaskBundleDraft | null }>(
        deps.withWorkspaceQueryFor(pid, `/api/task-bundle-drafts/${encodeURIComponent(id)}/approve`),
        { runQueue: Boolean(options?.runQueue) },
      );
      const updated = res?.draft ?? null;
      deleteDraftLocal(rt, id);
      return { ok: Boolean(res?.success), createdTaskIds: Array.isArray(res?.createdTaskIds) ? res.createdTaskIds : [], draft: updated };
    });
  };

  return {
    loadTaskBundleDrafts,
    updateTaskBundleDraft,
    deleteTaskBundleDraft,
    approveTaskBundleDraft,
  };
}

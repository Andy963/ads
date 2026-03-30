import { computed, ref, type Ref } from "vue";

import type { ApiClient } from "../../api/client";
import type { ReviewSnapshot, Task } from "../../api/types";
import { deriveTaskStage } from "../../lib/task_stage";

export function useTaskBoardReviewSnapshot(params: {
  tasks: Ref<Task[]>;
  api: Ref<ApiClient | undefined>;
  workspaceRoot: Ref<string | null | undefined>;
}) {
  const detailId = ref<string | null>(null);
  const reviewSnapshotOpen = ref(false);
  const reviewSnapshot = ref<ReviewSnapshot | null>(null);
  const reviewSnapshotBusy = ref(false);
  const reviewSnapshotError = ref<string | null>(null);

  const detailTask = computed(() => {
    const id = String(detailId.value ?? "").trim();
    if (!id) return null;
    return params.tasks.value.find((task) => task.id === id) ?? null;
  });

  const detailTaskStage = computed(() => {
    const task = detailTask.value;
    if (!task) return null;
    return deriveTaskStage(task);
  });

  const showTaskPromptInDetail = computed(() => detailTaskStage.value !== "in_review");
  const workspaceReady = computed(() => Boolean(String(params.workspaceRoot.value ?? "").trim()));

  const canViewReviewNotes = computed(() => {
    const task = detailTask.value;
    if (!task || !task.reviewRequired) return false;
    const snapshotId = String(task.reviewSnapshotId ?? "").trim();
    if (!snapshotId) return false;
    return Boolean(params.api.value) && workspaceReady.value;
  });

  const canMarkReviewDone = computed(() => {
    const task = detailTask.value;
    if (!task || !task.reviewRequired) return false;
    if (task.status !== "completed") return false;
    return task.reviewStatus !== "passed";
  });

  function withWorkspaceQuery(apiPath: string): string {
    const root = String(params.workspaceRoot.value ?? "").trim();
    if (!root) return apiPath;
    const joiner = apiPath.includes("?") ? "&" : "?";
    return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
  }

  function closeReviewSnapshot(): void {
    reviewSnapshotOpen.value = false;
    reviewSnapshot.value = null;
    reviewSnapshotBusy.value = false;
    reviewSnapshotError.value = null;
  }

  function closeDetail(): void {
    detailId.value = null;
    closeReviewSnapshot();
  }

  async function openReviewSnapshot(): Promise<void> {
    reviewSnapshotOpen.value = true;
    reviewSnapshot.value = null;
    reviewSnapshotBusy.value = false;
    reviewSnapshotError.value = null;

    const task = detailTask.value;
    const snapshotId = String(task?.reviewSnapshotId ?? "").trim();
    if (!snapshotId) {
      reviewSnapshotError.value = "No snapshot available";
      return;
    }
    if (!params.api.value) {
      reviewSnapshotError.value = "API client not available";
      return;
    }
    if (!workspaceReady.value) {
      reviewSnapshotError.value = "Workspace not selected";
      return;
    }

    reviewSnapshotBusy.value = true;
    try {
      const encoded = encodeURIComponent(snapshotId);
      reviewSnapshot.value = await params.api.value.get<ReviewSnapshot>(
        withWorkspaceQuery(`/api/review-snapshots/${encoded}`),
      );
    } catch (error) {
      reviewSnapshotError.value = error instanceof Error ? error.message : String(error);
    } finally {
      reviewSnapshotBusy.value = false;
    }
  }

  function formatTs(ts: number | null | undefined): string {
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  return {
    detailId,
    detailTask,
    detailTaskStage,
    showTaskPromptInDetail,
    canViewReviewNotes,
    canMarkReviewDone,
    reviewSnapshotOpen,
    reviewSnapshot,
    reviewSnapshotBusy,
    reviewSnapshotError,
    closeDetail,
    closeReviewSnapshot,
    openReviewSnapshot,
    formatTs,
  };
}

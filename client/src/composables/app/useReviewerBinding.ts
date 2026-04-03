import { computed, type Ref } from "vue";

import type { ReviewArtifactListResponse, Task } from "../../api/types";

type ReviewerRuntimeShape = {
  latestReviewArtifact: Ref<unknown>;
  boundReviewSnapshotId: Ref<string | null>;
};

function asReviewerRuntimeShape(value: unknown): ReviewerRuntimeShape {
  return value as ReviewerRuntimeShape;
}

export function useReviewerBinding(params: {
  tasks: Ref<Task[]>;
  selectedId: Ref<string | null>;
  activeReviewerRuntime: Ref<unknown>;
  reviewerConnected: Ref<boolean>;
  api: Ref<{ get<T>(url: string): Promise<T> }>;
  resolveActiveWorkspaceRoot: () => string | null | undefined;
  clearReviewerChat: () => void;
}) {
  const reviewerRuntime = computed(() => asReviewerRuntimeShape(params.activeReviewerRuntime.value));
  const reviewerLatestArtifact = computed(
    () => reviewerRuntime.value.latestReviewArtifact.value,
  );
  const reviewerBoundSnapshotId = computed(
    () => reviewerRuntime.value.boundReviewSnapshotId.value,
  );
  const reviewerBindingMutationBlocked = computed(() => !params.reviewerConnected.value);

  const selectedTask = computed(() => {
    const id = String(params.selectedId.value ?? "").trim();
    if (!id) return null;
    return params.tasks.value.find((task) => task.id === id) ?? null;
  });

  const selectedTaskReviewSnapshotId = computed(() => {
    const snapshotId = String(selectedTask.value?.reviewSnapshotId ?? "").trim();
    return snapshotId || null;
  });

  const selectedTaskReviewLabel = computed(() => {
    const task = selectedTask.value;
    if (!task) return "No task selected";
    return `${task.title || task.id} (${task.id.slice(0, 8)})`;
  });

  function withWorkspaceQuery(apiPath: string): string {
    const root = String(params.resolveActiveWorkspaceRoot() ?? "").trim();
    if (!root) return apiPath;
    const joiner = apiPath.includes("?") ? "&" : "?";
    return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
  }

  async function hydrateReviewerArtifact(snapshotId: string): Promise<void> {
    const sid = String(snapshotId ?? "").trim();
    if (!sid) {
      reviewerRuntime.value.latestReviewArtifact.value = null;
      return;
    }
    try {
      const result = await params.api.value.get<ReviewArtifactListResponse>(
        withWorkspaceQuery(`/api/review-artifacts?snapshotId=${encodeURIComponent(sid)}&limit=1`),
      );
      reviewerRuntime.value.latestReviewArtifact.value = Array.isArray(result.items)
        ? result.items[0] ?? null
        : null;
    } catch {
      reviewerRuntime.value.latestReviewArtifact.value = null;
    }
  }

  async function bindReviewerToSelectedSnapshot(): Promise<void> {
    if (reviewerBindingMutationBlocked.value) {
      return;
    }
    const snapshotId = String(selectedTaskReviewSnapshotId.value ?? "").trim();
    if (!snapshotId) {
      return;
    }
    const runtime = reviewerRuntime.value;
    const previous = String(runtime.boundReviewSnapshotId.value ?? "").trim();
    if (previous && previous !== snapshotId) {
      params.clearReviewerChat();
    }
    runtime.boundReviewSnapshotId.value = snapshotId;
    await hydrateReviewerArtifact(snapshotId);
  }

  function clearReviewerSnapshotBinding(): void {
    if (reviewerBindingMutationBlocked.value) {
      return;
    }
    params.clearReviewerChat();
  }

  return {
    reviewerLatestArtifact,
    reviewerBoundSnapshotId,
    reviewerBindingMutationBlocked,
    selectedTask,
    selectedTaskReviewSnapshotId,
    selectedTaskReviewLabel,
    bindReviewerToSelectedSnapshot,
    clearReviewerSnapshotBinding,
  };
}

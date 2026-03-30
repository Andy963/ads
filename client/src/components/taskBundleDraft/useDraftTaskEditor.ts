import { computed, ref } from "vue";

import type { TaskBundle, TaskBundleDraft } from "../../api/types";

export type EditingTask = {
  title: string;
  prompt: string;
};

function buildEditingTask(draft: TaskBundleDraft): EditingTask {
  const first = draft.bundle?.tasks?.[0];
  return {
    title: first?.title ?? "",
    prompt: first?.prompt ?? "",
  };
}

export function useDraftTaskEditor() {
  const editingTask = ref<EditingTask>({ title: "", prompt: "" });
  const originalTaskCount = ref(0);
  const taskDirty = ref(false);
  const editingError = ref<string | null>(null);

  const taskNormalizationPending = computed(() => originalTaskCount.value !== 1);

  function resetTaskState(): void {
    editingTask.value = { title: "", prompt: "" };
    originalTaskCount.value = 0;
    taskDirty.value = false;
    editingError.value = null;
  }

  function loadDraftTask(draft: TaskBundleDraft): void {
    editingTask.value = buildEditingTask(draft);
    originalTaskCount.value = draft.bundle?.tasks?.length ?? 0;
    taskDirty.value = false;
    editingError.value = null;
  }

  function markTaskDirty(): void {
    taskDirty.value = true;
  }

  function updateTaskTitle(value: string): void {
    editingTask.value = { ...editingTask.value, title: value };
    markTaskDirty();
  }

  function updateTaskPrompt(value: string): void {
    editingTask.value = { ...editingTask.value, prompt: value };
    markTaskDirty();
  }

  function buildBundle(
    draft: TaskBundleDraft | null,
  ): { ok: true; bundle: TaskBundle } | { ok: false; error: string } {
    if (!draft) return { ok: false, error: "未选择草稿" };

    const prompt = editingTask.value.prompt.trim();
    if (!prompt) {
      return { ok: false, error: "任务描述不能为空" };
    }

    const originalBundle = draft.bundle ?? { version: 1 as const, tasks: [] };
    const originalTask = originalBundle.tasks?.[0] ?? {};
    const nextTask = {
      ...originalTask,
      title: editingTask.value.title.trim() || originalTask.title || "Task 1",
      prompt,
    };

    return {
      ok: true,
      bundle: {
        ...originalBundle,
        version: 1 as const,
        tasks: [nextTask],
      } as TaskBundle,
    };
  }

  function applyLocalTaskBundle(draft: TaskBundleDraft, bundle: TaskBundle): TaskBundleDraft {
    const nextDraft: TaskBundleDraft = {
      ...draft,
      bundle,
    };
    editingTask.value = buildEditingTask(nextDraft);
    originalTaskCount.value = 1;
    taskDirty.value = false;
    return nextDraft;
  }

  return {
    editingTask,
    originalTaskCount,
    taskDirty,
    taskNormalizationPending,
    editingError,
    resetTaskState,
    loadDraftTask,
    updateTaskTitle,
    updateTaskPrompt,
    buildBundle,
    applyLocalTaskBundle,
  };
}

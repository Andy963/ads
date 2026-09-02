<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { TaskBundle, TaskBundleDraft } from "../api/types";
import TaskBundleDraftEditor from "./taskBundleDraft/TaskBundleDraftEditor.vue";
import TaskBundleDraftList from "./taskBundleDraft/TaskBundleDraftList.vue";
import { useDraftTaskEditor } from "./taskBundleDraft/useDraftTaskEditor";

const props = defineProps<{
  drafts: TaskBundleDraft[];
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "approve", payload: { id: string; runQueue: boolean }): void;
  (e: "delete", id: string): void;
  (e: "update", payload: { id: string; bundle: TaskBundle }): void;
}>();

const expanded = ref(false);
const selectedDraft = ref<TaskBundleDraft | null>(null);

const {
  editingTask,
  originalTaskCount,
  taskDirty,
  taskNormalizationPending,
  editingError,
  resetTaskState,
  loadDraftTask,
  updateTaskPrompt,
  buildBundle,
  applyLocalTaskBundle,
} = useDraftTaskEditor();

const draftCount = computed(() => (Array.isArray(props.drafts) ? props.drafts.length : 0));
const hasDrafts = computed(() => draftCount.value > 0);
const editorBusy = computed(() => Boolean(props.busy));
const canApproveDraft = computed(
  () =>
    !editorBusy.value &&
    !taskDirty.value &&
    !taskNormalizationPending.value &&
    selectedDraft.value?.status === "draft",
);
const canSaveTask = computed(
  () =>
    !editorBusy.value &&
    selectedDraft.value?.status === "draft" &&
    (taskDirty.value || taskNormalizationPending.value),
);
const taskStatusText = computed(() => {
  if (taskDirty.value) return "任务未保存";
  if (taskNormalizationPending.value) return "保存任务后会规范为单任务";
  return "编辑任务";
});

watch(
  () => draftCount.value,
  (count) => {
    if (count > 0 && !expanded.value) {
      expanded.value = true;
    }
  },
  { immediate: true },
);

function draftTitle(draft: TaskBundleDraft): string {
  const first = draft.bundle?.tasks?.[0];
  const title = String(first?.title ?? "").trim();
  if (title) return title;
  const prompt = String(first?.prompt ?? "").trim();
  if (prompt) {
    const firstLine =
      prompt
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "";
    return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  }
  return `草稿 ${draft.id.slice(0, 8)}`;
}

function openDraft(draft: TaskBundleDraft): void {
  selectedDraft.value = draft;
  loadDraftTask(draft);
}

function closeDraft(): void {
  selectedDraft.value = null;
  resetTaskState();
}

function saveTaskEditor(): void {
  const draft = selectedDraft.value;
  const result = buildBundle(draft);
  if (!result.ok) {
    editingError.value = result.error;
    return;
  }

  editingError.value = null;
  if (!draft) return;
  const nextDraft = applyLocalTaskBundle(draft, result.bundle);
  selectedDraft.value = nextDraft;
  emit("update", { id: draft.id, bundle: result.bundle });
}

function approve(runQueue: boolean): void {
  if (!selectedDraft.value) return;
  emit("approve", { id: selectedDraft.value.id, runQueue });
  closeDraft();
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <TaskBundleDraftList
    :drafts="drafts"
    :busy="busy"
    :error="error"
    :expanded="expanded"
    :draft-count="draftCount"
    :has-drafts="hasDrafts"
    :draft-title="draftTitle"
    @toggle="toggleExpanded"
    @refresh="emit('refresh')"
    @open="openDraft"
    @delete="emit('delete', $event)"
  />

  <TaskBundleDraftEditor
    v-if="selectedDraft"
    :selected-draft="selectedDraft"
    :busy="busy"
    :editing-error="editingError"
    :task-status-text="taskStatusText"
    :editing-task="editingTask"
    :original-task-count="originalTaskCount"
    :task-normalization-pending="taskNormalizationPending"
    :can-save-task="canSaveTask"
    :can-approve-draft="canApproveDraft"
    :draft-title="draftTitle"
    @close="closeDraft"
    @update-task-prompt="updateTaskPrompt"
    @save-task="saveTaskEditor"
    @approve="approve"
  />
</template>

<style src="./TaskBundleDraftPanel.css"></style>

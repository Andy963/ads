<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type {
  TaskBundle,
  TaskBundleDraft,
  TaskBundleDraftSpecFileKey,
} from "../api/types";
import TaskBundleDraftEditor from "./taskBundleDraft/TaskBundleDraftEditor.vue";
import TaskBundleDraftList from "./taskBundleDraft/TaskBundleDraftList.vue";
import {
  useDraftSpecEditor,
  type LoadSpecFileHandler,
  type LoadSpecSummaryHandler,
  type SaveSpecFileHandler,
} from "./taskBundleDraft/useDraftSpecEditor";
import { useDraftTaskEditor } from "./taskBundleDraft/useDraftTaskEditor";

type EditorTab = "task" | TaskBundleDraftSpecFileKey;

const props = defineProps<{
  drafts: TaskBundleDraft[];
  busy?: boolean;
  error?: string | null;
  loadSpecSummary?: LoadSpecSummaryHandler;
  loadSpecFile?: LoadSpecFileHandler;
  saveSpecFile?: SaveSpecFileHandler;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "approve", payload: { id: string; runQueue: boolean }): void;
  (e: "delete", id: string): void;
  (e: "update", payload: { id: string; bundle: TaskBundle }): void;
}>();

const expanded = ref(false);
const selectedDraft = ref<TaskBundleDraft | null>(null);
const activeTab = ref<EditorTab>("task");

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

const {
  specSummary,
  specSummaryLoading,
  specDocuments,
  specBusy,
  specDirty,
  specError,
  hasPendingSpecRequest,
  resetSpecState,
  invalidateSpecRequests,
  setCurrentSpecContent,
  ensureSpecSummaryLoaded,
  ensureSpecFileLoaded,
  saveCurrentSpecFile,
} = useDraftSpecEditor();

const draftCount = computed(() => (Array.isArray(props.drafts) ? props.drafts.length : 0));
const hasDrafts = computed(() => draftCount.value > 0);
const currentSpecKey = computed<TaskBundleDraftSpecFileKey | null>(() =>
  activeTab.value === "task" ? null : activeTab.value,
);
const currentTabIsTask = computed(() => activeTab.value === "task");
const hasUnsavedChanges = computed(() => taskDirty.value || specDirty.value.size > 0);
const editorBusy = computed(() => Boolean(props.busy));
const canApproveDraft = computed(
  () =>
    !editorBusy.value &&
    !hasPendingSpecRequest.value &&
    !hasUnsavedChanges.value &&
    !taskNormalizationPending.value &&
    selectedDraft.value?.status === "draft" &&
    Boolean(selectedDraft.value?.bundle),
);
const currentSpecStatusText = computed(() => {
  const file = currentSpecKey.value;
  if (!file) {
    if (taskDirty.value) return "任务未保存";
    if (taskNormalizationPending.value) return "保存任务后会规范为单任务";
    return "编辑任务";
  }
  if (specSummaryLoading.value) return "加载中…";
  if (specBusy.value[file] === "saving") return "保存中…";
  if (specBusy.value[file] === "loading") return "加载中…";
  if (specDirty.value.has(file)) return "未保存";
  if (specDocuments.value[file] !== undefined) return "已加载";
  return "按需加载";
});
const currentSpecContent = computed(() => {
  const file = currentSpecKey.value;
  return file ? specDocuments.value[file] ?? "" : "";
});
const missingSpecFiles = computed(
  () => specSummary.value?.files.filter((entry) => entry.missing).map((entry) => entry.fileName) ?? [],
);
const currentSpecMissing = computed(() => {
  const file = currentSpecKey.value;
  if (!file) return false;
  return specSummary.value?.files.some((entry) => entry.key === file && entry.missing) ?? false;
});
const canSaveCurrentTab = computed(() => {
  if (editorBusy.value || selectedDraft.value?.status !== "draft") return false;
  const file = currentSpecKey.value;
  if (!file) return taskDirty.value || taskNormalizationPending.value;
  return (
    !specSummaryLoading.value &&
    specBusy.value[file] !== "loading" &&
    specBusy.value[file] !== "saving" &&
    specDirty.value.has(file)
  );
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

function editorTabLabel(tab: EditorTab): string {
  switch (tab) {
    case "task":
      return "Task";
    case "requirements":
      return "Requirements";
    case "design":
      return "Design";
    case "implementation":
      return "Implementation";
    default:
      return tab;
  }
}

async function openDraft(draft: TaskBundleDraft): Promise<void> {
  selectedDraft.value = draft;
  activeTab.value = "task";
  resetSpecState();
  invalidateSpecRequests();
  loadDraftTask(draft);
}

function closeDraft(): void {
  selectedDraft.value = null;
  activeTab.value = "task";
  resetTaskState();
  resetSpecState();
  invalidateSpecRequests();
}

async function switchEditorTab(tab: EditorTab): Promise<void> {
  activeTab.value = tab;
  if (tab === "task") return;
  await ensureSpecSummaryLoaded(selectedDraft.value, props.loadSpecSummary);
  await ensureSpecFileLoaded(selectedDraft.value, tab, props.loadSpecFile);
}

async function reloadCurrentSpecFile(): Promise<void> {
  const file = currentSpecKey.value;
  if (!file) return;
  if (specDirty.value.has(file)) {
    const ok =
      typeof window === "undefined"
        ? true
        : window.confirm("当前文件有未保存修改，重新加载会丢失这些更改。继续吗？");
    if (!ok) return;
  }
  await ensureSpecFileLoaded(selectedDraft.value, file, props.loadSpecFile, { force: true });
}

async function saveTaskEditor(): Promise<void> {
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

async function saveCurrentTab(): Promise<void> {
  if (currentTabIsTask.value) {
    await saveTaskEditor();
    return;
  }
  await saveCurrentSpecFile(selectedDraft.value, currentSpecKey.value, props.saveSpecFile);
}

function updateSpecContent(value: string): void {
  const file = currentSpecKey.value;
  if (!file) return;
  setCurrentSpecContent(file, value);
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
    :spec-error="specError"
    :current-tab-is-task="currentTabIsTask"
    :current-spec-key="currentSpecKey"
    :current-spec-status-text="currentSpecStatusText"
    :current-spec-missing="currentSpecMissing"
    :current-spec-content="currentSpecContent"
    :active-tab="activeTab"
    :editing-task="editingTask"
    :original-task-count="originalTaskCount"
    :task-dirty="taskDirty"
    :task-normalization-pending="taskNormalizationPending"
    :spec-summary-loading="specSummaryLoading"
    :spec-busy="specBusy"
    :spec-dirty="specDirty"
    :missing-spec-files="missingSpecFiles"
    :can-save-current-tab="canSaveCurrentTab"
    :can-approve-draft="canApproveDraft"
    :draft-title="draftTitle"
    :editor-tab-label="editorTabLabel"
    @close="closeDraft"
    @switch-tab="switchEditorTab"
    @reload="reloadCurrentSpecFile"
    @update-task-prompt="updateTaskPrompt"
    @update-spec-content="updateSpecContent"
    @save-current-tab="saveCurrentTab"
    @approve="approve"
  />
</template>

<style src="./TaskBundleDraftPanel.css" scoped></style>

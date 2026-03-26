<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Delete, Refresh } from "@element-plus/icons-vue";

import DraggableModal from "./DraggableModal.vue";

import type {
  TaskBundle,
  TaskBundleDraft,
  TaskBundleDraftSpecDocument,
  TaskBundleDraftSpecFileKey,
  TaskBundleDraftSpecFileUpdate,
  TaskBundleDraftSpecSummary,
} from "../api/types";

type EditingTask = { title: string; prompt: string };
type EditorTab = "task" | TaskBundleDraftSpecFileKey;
type LoadSpecSummaryHandler = (draftId: string) => Promise<TaskBundleDraftSpecSummary | null>;
type LoadSpecFileHandler = (payload: { id: string; file: TaskBundleDraftSpecFileKey }) => Promise<TaskBundleDraftSpecDocument | null>;
type SaveSpecFileHandler = (payload: {
  id: string;
  file: TaskBundleDraftSpecFileKey;
  update: TaskBundleDraftSpecFileUpdate;
}) => Promise<TaskBundleDraftSpecDocument | null>;
type SpecBusyState = Partial<Record<TaskBundleDraftSpecFileKey, "loading" | "saving">>;
type SpecDocState = Partial<Record<TaskBundleDraftSpecFileKey, string>>;

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
const editingTask = ref<EditingTask>({ title: "", prompt: "" });
const originalTaskCount = ref(0);
const taskDirty = ref(false);
const specSummary = ref<TaskBundleDraftSpecSummary | null>(null);
const specSummaryLoading = ref(false);
const specDocuments = ref<SpecDocState>({});
const specBusy = ref<SpecBusyState>({});
const specDirty = ref(new Set<TaskBundleDraftSpecFileKey>());
const editingError = ref<string | null>(null);
const specError = ref<string | null>(null);
let specRequestToken = 0;

const draftCount = computed(() => (Array.isArray(props.drafts) ? props.drafts.length : 0));
const hasDrafts = computed(() => draftCount.value > 0);
const currentSpecKey = computed<TaskBundleDraftSpecFileKey | null>(() => (activeTab.value === "task" ? null : activeTab.value));
const currentTabIsTask = computed(() => activeTab.value === "task");
const taskNormalizationPending = computed(() => originalTaskCount.value !== 1);
const hasPendingSpecRequest = computed(() => specSummaryLoading.value || Object.keys(specBusy.value).length > 0);
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
const currentSpecContent = computed({
  get: () => {
    const file = currentSpecKey.value;
    return file ? specDocuments.value[file] ?? "" : "";
  },
  set: (value: string) => {
    const file = currentSpecKey.value;
    if (!file) return;
    specDocuments.value = { ...specDocuments.value, [file]: value };
    specDirty.value = new Set([...specDirty.value, file]);
  },
});
const missingSpecFiles = computed(() => specSummary.value?.files.filter((entry) => entry.missing).map((entry) => entry.fileName) ?? []);
const currentSpecMissing = computed(() => {
  const file = currentSpecKey.value;
  if (!file) return false;
  return specSummary.value?.files.some((entry) => entry.key === file && entry.missing) ?? false;
});
const canSaveCurrentTab = computed(() => {
  if (editorBusy.value || selectedDraft.value?.status !== "draft") return false;
  const file = currentSpecKey.value;
  if (!file) return taskDirty.value || taskNormalizationPending.value;
  return !specSummaryLoading.value && specBusy.value[file] !== "loading" && specBusy.value[file] !== "saving" && specDirty.value.has(file);
});

watch(
  () => draftCount.value,
  (n) => {
    if (n > 0 && !expanded.value) {
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
    const firstLine = prompt.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
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

function resetSpecState(): void {
  specSummary.value = null;
  specSummaryLoading.value = false;
  specDocuments.value = {};
  specBusy.value = {};
  specDirty.value = new Set();
  specError.value = null;
}

function resetTaskState(): void {
  editingTask.value = { title: "", prompt: "" };
  originalTaskCount.value = 0;
  taskDirty.value = false;
}

function setSpecBusy(file: TaskBundleDraftSpecFileKey, state: "loading" | "saving" | null): void {
  const next = { ...specBusy.value };
  if (state === null) {
    delete next[file];
  } else {
    next[file] = state;
  }
  specBusy.value = next;
}

function buildEditingTask(draft: TaskBundleDraft): EditingTask {
  const first = draft.bundle?.tasks?.[0];
  return {
    title: first?.title ?? "",
    prompt: first?.prompt ?? "",
  };
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

async function ensureSpecSummaryLoaded(): Promise<void> {
  const draft = selectedDraft.value;
  if (!draft || specSummary.value || specSummaryLoading.value || !props.loadSpecSummary) {
    return;
  }
  const specRef = String(draft.bundle?.specRef ?? "").trim();
  if (!specRef) return;

  const token = ++specRequestToken;
  specSummaryLoading.value = true;
  specError.value = null;
  try {
    const loaded = await props.loadSpecSummary(draft.id);
    if (token !== specRequestToken || selectedDraft.value?.id !== draft.id) return;
    if (!loaded) {
      specError.value = "未能加载 spec 内容";
      return;
    }
    specSummary.value = loaded;
  } catch (error) {
    if (token !== specRequestToken || selectedDraft.value?.id !== draft.id) return;
    specError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (token === specRequestToken) {
      specSummaryLoading.value = false;
    }
  }
}

async function ensureSpecFileLoaded(file: TaskBundleDraftSpecFileKey, options?: { force?: boolean }): Promise<void> {
  const draft = selectedDraft.value;
  if (!draft || !props.loadSpecFile) return;
  if (!options?.force && specDocuments.value[file] !== undefined) return;

  const token = ++specRequestToken;
  setSpecBusy(file, "loading");
  specError.value = null;
  try {
    const loaded = await props.loadSpecFile({ id: draft.id, file });
    if (token !== specRequestToken || selectedDraft.value?.id !== draft.id) return;
    if (!loaded) {
      specError.value = "未能加载 spec 内容";
      return;
    }
    specDocuments.value = { ...specDocuments.value, [file]: loaded.content };
    if (loaded.missing && specSummary.value) {
      specSummary.value = {
        ...specSummary.value,
        files: specSummary.value.files.map((entry) => (entry.key === file ? { ...entry, missing: true } : entry)),
      };
    }
    const nextDirty = new Set(specDirty.value);
    nextDirty.delete(file);
    specDirty.value = nextDirty;
  } catch (error) {
    if (token !== specRequestToken || selectedDraft.value?.id !== draft.id) return;
    specError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (token === specRequestToken) {
      setSpecBusy(file, null);
    }
  }
}

async function openDraft(draft: TaskBundleDraft): Promise<void> {
  selectedDraft.value = draft;
  activeTab.value = "task";
  editingError.value = null;
  resetSpecState();
  specRequestToken += 1;
  editingTask.value = buildEditingTask(draft);
  originalTaskCount.value = draft.bundle?.tasks?.length ?? 0;
  taskDirty.value = false;
}

function closeDraft(): void {
  selectedDraft.value = null;
  activeTab.value = "task";
  editingError.value = null;
  resetTaskState();
  resetSpecState();
  specRequestToken += 1;
}

function buildBundle(): { ok: true; bundle: TaskBundle } | { ok: false; error: string } {
  const draft = selectedDraft.value;
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

function applyLocalTaskBundle(bundle: TaskBundle): void {
  if (!selectedDraft.value) return;
  selectedDraft.value = {
    ...selectedDraft.value,
    bundle,
  };
  editingTask.value = buildEditingTask(selectedDraft.value);
  originalTaskCount.value = 1;
  taskDirty.value = false;
}

async function saveTaskEditor(): Promise<void> {
  const draft = selectedDraft.value;
  if (!draft) return;
  const result = buildBundle();
  if (!result.ok) {
    editingError.value = result.error;
    return;
  }

  editingError.value = null;
  applyLocalTaskBundle(result.bundle);
  emit("update", { id: draft.id, bundle: result.bundle });
}

async function switchEditorTab(tab: EditorTab): Promise<void> {
  activeTab.value = tab;
  if (tab === "task") return;
  await ensureSpecSummaryLoaded();
  await ensureSpecFileLoaded(tab);
}

async function reloadCurrentSpecFile(): Promise<void> {
  const file = currentSpecKey.value;
  if (!file) return;
  if (specDirty.value.has(file)) {
    const ok = typeof window === "undefined" ? true : window.confirm("当前文件有未保存修改，重新加载会丢失这些更改。继续吗？");
    if (!ok) return;
  }
  await ensureSpecFileLoaded(file, { force: true });
}

async function saveCurrentSpecFile(): Promise<void> {
  const draft = selectedDraft.value;
  const file = currentSpecKey.value;
  if (!draft || !file || !props.saveSpecFile) return;
  if (!specDirty.value.has(file)) return;

  setSpecBusy(file, "saving");
  specError.value = null;
  try {
    const saved = await props.saveSpecFile({
      id: draft.id,
      file,
      update: { content: specDocuments.value[file] ?? "" },
    });
    if (!saved) {
      specError.value = "未能保存 spec 内容";
      return;
    }
    specDocuments.value = { ...specDocuments.value, [file]: saved.content };
    if (specSummary.value) {
      specSummary.value = {
        ...specSummary.value,
        files: specSummary.value.files.map((entry) => (entry.key === file ? { ...entry, missing: saved.missing } : entry)),
      };
    }
    const nextDirty = new Set(specDirty.value);
    nextDirty.delete(file);
    specDirty.value = nextDirty;
  } catch (error) {
    specError.value = error instanceof Error ? error.message : String(error);
  } finally {
    setSpecBusy(file, null);
  }
}

async function saveCurrentTab(): Promise<void> {
  if (currentTabIsTask.value) {
    await saveTaskEditor();
    return;
  }
  await saveCurrentSpecFile();
}

function approve(id: string, runQueue: boolean): void {
  emit("approve", { id, runQueue });
  closeDraft();
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <section class="draftPanel" data-testid="task-bundle-drafts">
    <header class="draftHeader">
      <button
        type="button"
        class="draftToggle"
        :aria-expanded="expanded"
        data-testid="task-bundle-drafts-toggle"
        @click="toggleExpanded"
      >
        <span class="draftTitle">任务草稿</span>
        <span class="draftCount" :class="{ 'draftCount--active': hasDrafts }">{{ draftCount }}</span>
      </button>

      <div class="draftHeaderActions">
        <button
          type="button"
          class="draftIconButton"
          :disabled="Boolean(busy)"
          data-testid="task-bundle-drafts-refresh"
          title="刷新"
          aria-label="刷新"
          @click="emit('refresh')"
        >
          <Refresh />
        </button>
      </div>
    </header>

    <div v-if="expanded" class="draftBody">
      <div v-if="error" class="draftError" data-testid="task-bundle-drafts-error">{{ error }}</div>
      <div v-else-if="!hasDrafts" class="draftEmpty">暂无草稿</div>

      <div v-else class="draftList">
        <div
          v-for="draft in drafts"
          :key="draft.id"
          class="draftRow"
          :data-testid="`task-bundle-draft-${draft.id}`"
          @click="openDraft(draft)"
        >
          <div class="draftRowLeft">
            <span class="draftRowTitle">{{ draftTitle(draft) }}</span>
            <span v-if="draft.degradeReason" class="draftRowDegraded" :title="draft.degradeReason">⚠️ 已降级</span>
          </div>
          <div class="draftRowRight">
            <button
              type="button"
              class="draftRowDelete"
              :disabled="Boolean(busy)"
              title="删除"
              aria-label="删除"
              data-testid="task-bundle-draft-delete"
              @click.stop="emit('delete', draft.id)"
            >
              <Delete />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <DraggableModal
    v-if="selectedDraft"
    card-variant="large"
    data-testid="task-bundle-draft-edit-modal"
    @close="closeDraft"
  >
    <div class="modalBody">
      <div class="editorHeader" data-drag-handle>
        <div class="editorTitleBlock">
          <div class="editorTitle">{{ draftTitle(selectedDraft) }}</div>
          <div class="editorMeta">
            <span v-if="selectedDraft.bundle?.specRef" data-testid="task-bundle-draft-spec-ref">{{ selectedDraft.bundle.specRef }}</span>
            <span>{{ currentSpecStatusText }}</span>
          </div>
        </div>
        <button
          type="button"
          class="iconBtn"
          :disabled="Boolean(busy)"
          aria-label="关闭"
          title="关闭"
          @click="closeDraft"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fill-rule="evenodd"
              d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
      </div>

      <div v-if="editingError" class="modalError" data-testid="task-bundle-draft-error">{{ editingError }}</div>
      <div v-if="specError" class="modalError" data-testid="task-bundle-draft-spec-error">{{ specError }}</div>
      <div v-if="selectedDraft?.degradeReason" class="modalWarning" data-testid="task-bundle-draft-degrade-reason">
        ⚠️ 此草稿已从自动入队降级：{{ selectedDraft.degradeReason }}
      </div>
      <div
        v-if="currentTabIsTask && taskNormalizationPending"
        class="modalWarning"
        data-testid="task-bundle-draft-task-normalization-warning"
      >
        ⚠️ 当前草稿包含 {{ originalTaskCount }} 个任务。保存后会规范为单任务。
      </div>
      <div
        v-if="!currentTabIsTask && missingSpecFiles.length > 0"
        class="modalWarning"
        data-testid="task-bundle-draft-spec-missing-files"
      >
        ⚠️ 缺少文件：{{ missingSpecFiles.join(", ") }}。保存对应标签时会补齐对应文件。
      </div>

      <div class="editorTabs" role="tablist" aria-label="Draft editor tabs">
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'task', 'editorTab--dirty': taskDirty || taskNormalizationPending }"
          data-testid="task-bundle-draft-tab-task"
          @click="switchEditorTab('task')"
        >
          <span>Task</span>
          <span v-if="taskDirty || taskNormalizationPending" class="editorTabBadge">未保存</span>
        </button>
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'requirements', 'editorTab--dirty': specDirty.has('requirements') }"
          data-testid="task-bundle-draft-tab-requirements"
          @click="switchEditorTab('requirements')"
        >
          <span>{{ editorTabLabel("requirements") }}</span>
          <span v-if="specDirty.has('requirements')" class="editorTabBadge">未保存</span>
        </button>
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'design', 'editorTab--dirty': specDirty.has('design') }"
          data-testid="task-bundle-draft-tab-design"
          @click="switchEditorTab('design')"
        >
          <span>{{ editorTabLabel("design") }}</span>
          <span v-if="specDirty.has('design')" class="editorTabBadge">未保存</span>
        </button>
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'implementation', 'editorTab--dirty': specDirty.has('implementation') }"
          data-testid="task-bundle-draft-tab-implementation"
          @click="switchEditorTab('implementation')"
        >
          <span>{{ editorTabLabel("implementation") }}</span>
          <span v-if="specDirty.has('implementation')" class="editorTabBadge">未保存</span>
        </button>
      </div>

      <div class="editorToolbar">
        <div class="editorToolbarHint">
          <span v-if="currentTabIsTask">只编辑单个任务。</span>
          <span v-else-if="currentSpecMissing">当前文件不存在，保存后会创建。</span>
          <span v-else>当前标签只加载并保存对应文件。</span>
        </div>
        <div class="editorToolbarActions">
          <button
            v-if="!currentTabIsTask"
            type="button"
            class="btnGhost"
            :disabled="currentSpecKey == null || specSummaryLoading || specBusy[currentSpecKey] === 'loading' || specBusy[currentSpecKey] === 'saving'"
            data-testid="task-bundle-draft-reload"
            @click="reloadCurrentSpecFile"
          >
            重新加载
          </button>
        </div>
      </div>

      <div class="editorViewport" data-testid="task-bundle-draft-viewport">
        <div v-if="currentTabIsTask" class="editorPanel editorPanel--task" data-testid="task-bundle-draft-task-panel">
          <label class="field">
            <span class="fieldLabel">Title</span>
            <input
              :value="editingTask.title"
              data-testid="task-bundle-draft-task-title"
              @input="updateTaskTitle(($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="field">
            <span class="fieldLabel">Description</span>
            <textarea
              :value="editingTask.prompt"
              class="fieldTextarea"
              rows="18"
              data-testid="task-bundle-draft-task-prompt"
              @input="updateTaskPrompt(($event.target as HTMLTextAreaElement).value)"
            />
          </label>
        </div>

        <div
          v-else-if="!selectedDraft.bundle?.specRef"
          class="specEmpty"
          data-testid="task-bundle-draft-spec-empty"
        >
          当前草稿还没有绑定 specRef，需先让 planner 生成或关联 spec。
        </div>

        <div
          v-else-if="specSummaryLoading || (currentSpecKey && specBusy[currentSpecKey] === 'loading' && specDocuments[currentSpecKey] === undefined)"
          class="specEmpty"
          data-testid="task-bundle-draft-spec-loading"
        >
          正在加载当前标签…
        </div>

        <div v-else class="editorPanel editorPanel--spec" data-testid="task-bundle-draft-spec-panel">
          <textarea
            v-model="currentSpecContent"
            class="fieldTextarea fieldTextarea--spec"
            rows="20"
            :disabled="currentSpecKey != null && specBusy[currentSpecKey] === 'loading'"
            :data-testid="`task-bundle-draft-spec-${currentSpecKey}`"
          />
        </div>
      </div>

      <div class="modalActions">
        <button type="button" class="btnSecondary" data-testid="task-bundle-draft-cancel" @click="closeDraft">取消</button>
        <button
          type="button"
          class="btnSecondary"
          :disabled="!canSaveCurrentTab"
          data-testid="task-bundle-draft-save-current-tab"
          @click="saveCurrentTab"
        >
          保存当前标签
        </button>
        <button
          type="button"
          class="btnPrimary"
          :disabled="!canApproveDraft"
          data-testid="task-bundle-draft-approve"
          @click="approve(selectedDraft.id, false)"
        >
          批准
        </button>
        <button
          type="button"
          class="btnPrimary"
          :disabled="!canApproveDraft"
          data-testid="task-bundle-draft-approve-run"
          @click="approve(selectedDraft.id, true)"
        >
          批准并运行
        </button>
      </div>
    </div>
  </DraggableModal>
</template>

<style src="./TaskBundleDraftPanel.css" scoped></style>

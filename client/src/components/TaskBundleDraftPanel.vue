<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Delete, Refresh } from "@element-plus/icons-vue";

import DraggableModal from "./DraggableModal.vue";

import type { TaskBundle, TaskBundleDraft } from "../api/types";

type EditingTask = { title: string; prompt: string };

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
const editingTasks = ref<EditingTask[]>([]);
const editingError = ref<string | null>(null);

const draftCount = computed(() => (Array.isArray(props.drafts) ? props.drafts.length : 0));
const hasDrafts = computed(() => draftCount.value > 0);

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
  const tasks = draft.bundle?.tasks ?? [];
  const first = tasks[0];
  const title = String(first?.title ?? "").trim();
  if (title) return title;
  const prompt = String(first?.prompt ?? "").trim();
  if (prompt) {
    const firstLine = prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  }
  return `草稿 ${draft.id.slice(0, 8)}`;
}

function openDraft(draft: TaskBundleDraft): void {
  selectedDraft.value = draft;
  editingError.value = null;
  const tasks = draft.bundle?.tasks ?? [];
  editingTasks.value = tasks.map((t) => ({
    title: t.title ?? "",
    prompt: t.prompt ?? "",
  }));
}

function closeDraft(): void {
  selectedDraft.value = null;
  editingTasks.value = [];
  editingError.value = null;
}

function buildBundle(): { ok: true; bundle: TaskBundle } | { ok: false; error: string } {
  const draft = selectedDraft.value;
  if (!draft) return { ok: false, error: "未选择草稿" };

  const tasks = editingTasks.value;
  for (let i = 0; i < tasks.length; i++) {
    const prompt = tasks[i].prompt.trim();
    if (!prompt) {
      return { ok: false, error: `任务 ${i + 1} 的描述不能为空` };
    }
  }

  const originalBundle = draft.bundle ?? { version: 1 as const, tasks: [] };
  const originalTasks = originalBundle.tasks ?? [];

  const mergedTasks = tasks.map((t, i) => {
    const orig = originalTasks[i] ?? {};
    return {
      ...orig,
      title: t.title.trim() || orig.title || `Task ${i + 1}`,
      prompt: t.prompt.trim(),
    };
  });

  return {
    ok: true,
    bundle: {
      ...originalBundle,
      version: 1 as const,
      tasks: mergedTasks,
    } as TaskBundle,
  };
}

function saveEditor(): void {
  const draft = selectedDraft.value;
  if (!draft) return;
  const result = buildBundle();
  if (!result.ok) {
    editingError.value = result.error;
    return;
  }
  editingError.value = null;
  emit("update", { id: draft.id, bundle: result.bundle });
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
      <div v-if="editingError" class="modalError" data-testid="task-bundle-draft-error">{{ editingError }}</div>
      <div v-if="selectedDraft?.degradeReason" class="modalWarning" data-testid="task-bundle-draft-degrade-reason">
        ⚠️ 此草稿已从自动入队降级：{{ selectedDraft.degradeReason }}
      </div>

      <div class="taskFormList">
        <div v-for="(task, idx) in editingTasks" :key="idx" class="taskFormCard">
          <div class="taskFormHeader" data-drag-handle>
            <input v-model="task.title" class="taskFormTitleInput" placeholder="任务标题" :data-testid="`task-bundle-draft-task-title-${idx}`" />
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
          <label class="field">
            <span class="fieldLabel">任务描述</span>
            <textarea v-model="task.prompt" class="fieldTextarea" rows="16" :data-testid="`task-bundle-draft-task-prompt-${idx}`" />
          </label>
        </div>
      </div>

      <div class="modalActions">
        <button type="button" class="btnSecondary" data-testid="task-bundle-draft-cancel" @click="closeDraft">取消</button>
        <button
          type="button"
          class="btnSecondary"
          :disabled="Boolean(busy) || selectedDraft.status !== 'draft'"
          data-testid="task-bundle-draft-save"
          @click="saveEditor"
        >
          保存
        </button>
        <button
          type="button"
          class="btnPrimary"
          :disabled="Boolean(busy) || selectedDraft.status !== 'draft' || !selectedDraft.bundle"
          data-testid="task-bundle-draft-approve"
          @click="approve(selectedDraft.id, false)"
        >
          批准
        </button>
        <button
          type="button"
          class="btnPrimary"
          :disabled="Boolean(busy) || selectedDraft.status !== 'draft' || !selectedDraft.bundle"
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

<script setup lang="ts">
import { computed } from "vue";

import DraggableModal from "../DraggableModal.vue";

import type { TaskBundleDraft } from "../../api/types";
import type { EditingTask } from "./useDraftTaskEditor";

const props = defineProps<{
  selectedDraft: TaskBundleDraft;
  busy?: boolean;
  editingError?: string | null;
  taskStatusText: string;
  editingTask: EditingTask;
  originalTaskCount: number;
  taskNormalizationPending: boolean;
  canSaveTask: boolean;
  canApproveDraft: boolean;
  draftTitle: (draft: TaskBundleDraft) => string;
}>();

// The prompt is intentionally short, so the reviewer must see the paired
// directories before approving the task.
const issueRef = computed(() => String(props.selectedDraft.bundle?.issueRef ?? "").trim());
const specRef = computed(() => String(props.selectedDraft.bundle?.specRef ?? "").trim());

const emit = defineEmits<{
  (e: "close"): void;
  (e: "update-task-prompt", value: string): void;
  (e: "save-task"): void;
  (e: "approve", runQueue: boolean): void;
}>();
</script>

<template>
  <DraggableModal
    card-variant="large"
    data-testid="task-bundle-draft-edit-modal"
    @close="emit('close')"
  >
    <div class="modalBody">
      <div class="editorHeader" data-drag-handle>
        <div class="editorTitleBlock">
          <div class="editorTitle">{{ draftTitle(selectedDraft) }}</div>
          <div class="editorMeta">
            <span>{{ taskStatusText }}</span>
            <span v-if="issueRef" class="editorSpecRef" :title="issueRef" data-testid="task-bundle-draft-issue-ref">
              📝 {{ issueRef }}
            </span>
            <span v-if="specRef" class="editorSpecRef" :title="specRef" data-testid="task-bundle-draft-spec-ref">
              📄 {{ specRef }}
            </span>
          </div>
        </div>
        <button
          type="button"
          class="iconBtn"
          :disabled="Boolean(busy)"
          aria-label="关闭"
          title="关闭"
          @click="emit('close')"
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
      <div v-if="!issueRef || !specRef" class="modalWarning" data-testid="task-bundle-draft-missing-spec">
        ⚠️ 此草稿未绑定成对的 issue/spec 目录。补齐引用后才能批准交给 Worker 执行。
      </div>
      <div v-if="selectedDraft.degradeReason" class="modalWarning" data-testid="task-bundle-draft-degrade-reason">
        ⚠️ 此草稿已从自动入队降级：{{ selectedDraft.degradeReason }}
      </div>
      <div
        v-if="taskNormalizationPending"
        class="modalWarning"
        data-testid="task-bundle-draft-task-normalization-warning"
      >
        ⚠️ 当前草稿包含 {{ originalTaskCount }} 个任务。保存后会规范为单任务。
      </div>

      <div class="editorViewport" data-testid="task-bundle-draft-viewport">
        <div class="editorPanel editorPanel--task" data-testid="task-bundle-draft-task-panel">
          <label class="field">
            <span class="fieldLabel">Description</span>
            <textarea
              :value="editingTask.prompt"
              class="fieldTextarea"
              rows="18"
              data-testid="task-bundle-draft-task-prompt"
              @input="emit('update-task-prompt', ($event.target as HTMLTextAreaElement).value)"
            />
          </label>
        </div>
      </div>

      <div class="modalActions">
        <button type="button" class="btnSecondary" data-testid="task-bundle-draft-cancel" @click="emit('close')">取消</button>
        <button
          type="button"
          class="btnSecondary"
          :disabled="!canSaveTask"
          data-testid="task-bundle-draft-save-task"
          @click="emit('save-task')"
        >
          保存任务
        </button>
        <button
          type="button"
          class="btnPrimary"
          :disabled="!canApproveDraft"
          data-testid="task-bundle-draft-approve"
          @click="emit('approve', false)"
        >
          批准
        </button>
        <button
          type="button"
          class="btnPrimary"
          :disabled="!canApproveDraft"
          data-testid="task-bundle-draft-approve-run"
          @click="emit('approve', true)"
        >
          批准并运行
        </button>
      </div>
    </div>
  </DraggableModal>
</template>

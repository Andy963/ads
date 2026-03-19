<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Task } from "../api/types";
import DraggableModal from "./DraggableModal.vue";

type EditAgentOption = {
  id: string;
  label: string;
};

const props = defineProps<{
  task: Task | null;
  error: string | null;
  title: string;
  prompt: string;
  agentId: string;
  priority: number;
  maxRetries: number;
  reviewRequired: boolean;
  bootstrapEnabled: boolean;
  bootstrapProject: string;
  bootstrapMaxIterations: number;
  agentOptions: EditAgentOption[];
  showSaveButton: boolean;
  primaryLabel: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "save"): void;
  (e: "saveAndRun"): void;
  (e: "update:title", value: string): void;
  (e: "update:prompt", value: string): void;
  (e: "update:agentId", value: string): void;
  (e: "update:priority", value: number): void;
  (e: "update:maxRetries", value: number): void;
  (e: "update:reviewRequired", value: boolean): void;
  (e: "update:bootstrapEnabled", value: boolean): void;
  (e: "update:bootstrapProject", value: string): void;
  (e: "update:bootstrapMaxIterations", value: number): void;
}>();

const editTitleEl = ref<HTMLInputElement | null>(null);

const titleModel = computed({
  get: () => props.title,
  set: (value: string) => emit("update:title", value),
});

const promptModel = computed({
  get: () => props.prompt,
  set: (value: string) => emit("update:prompt", value),
});

const agentIdModel = computed({
  get: () => props.agentId,
  set: (value: string) => emit("update:agentId", value),
});

const priorityModel = computed({
  get: () => props.priority,
  set: (value: number) => emit("update:priority", value),
});

const maxRetriesModel = computed({
  get: () => props.maxRetries,
  set: (value: number) => emit("update:maxRetries", value),
});

const reviewRequiredModel = computed({
  get: () => props.reviewRequired,
  set: (value: boolean) => emit("update:reviewRequired", value),
});

const bootstrapEnabledModel = computed({
  get: () => props.bootstrapEnabled,
  set: (value: boolean) => emit("update:bootstrapEnabled", value),
});

const bootstrapProjectModel = computed({
  get: () => props.bootstrapProject,
  set: (value: string) => emit("update:bootstrapProject", value),
});

const bootstrapMaxIterationsModel = computed({
  get: () => props.bootstrapMaxIterations,
  set: (value: number) => emit("update:bootstrapMaxIterations", value),
});

onMounted(() => {
  editTitleEl.value?.focus();
});
</script>

<template>
  <DraggableModal card-variant="large" data-testid="task-edit-modal" @close="emit('close')">
    <div class="editModalInner">
      <div class="modalHeader">
        <div class="modalTitle" data-drag-handle>编辑任务</div>
        <button
          class="iconBtn"
          type="button"
          aria-label="关闭"
          title="关闭"
          data-testid="task-edit-modal-cancel"
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

      <div class="modalBody">
        <div class="modalTitle main" data-drag-handle>编辑任务</div>
        <div v-if="props.error" class="err">{{ props.error }}</div>

        <label class="field">
          <span class="label">标题</span>
          <input ref="editTitleEl" v-model="titleModel" data-testid="task-edit-title" />
        </label>

        <div class="configRow">
          <label class="field">
            <span class="label">执行器</span>
            <select v-model="agentIdModel" data-testid="task-edit-agent">
              <option value="">自动</option>
              <option v-for="a in props.agentOptions" :key="a.id" :value="a.id">
                {{ a.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="label">优先级</span>
            <input v-model.number="priorityModel" type="number" />
          </label>
          <label class="field">
            <span class="label">最大重试</span>
            <input v-model.number="maxRetriesModel" type="number" min="0" />
          </label>
        </div>

        <div class="configRow configRowCheckboxes">
          <label class="field bootstrapToggle">
            <input v-model="reviewRequiredModel" type="checkbox" data-testid="task-edit-review-required" />
            <span class="checkboxLabel">需要 Reviewer 审核</span>
          </label>
          <label class="field bootstrapToggle">
            <input v-model="bootstrapEnabledModel" type="checkbox" data-testid="task-edit-bootstrap-toggle" />
            <span class="checkboxLabel">自举模式</span>
          </label>
        </div>

        <div v-if="bootstrapEnabledModel" class="configRow">
          <label class="field projectField">
            <span class="label">项目路径 / Git URL</span>
            <input
              v-model="bootstrapProjectModel"
              placeholder="/path/to/project 或 https://..."
              data-testid="task-edit-bootstrap-project"
            />
          </label>
          <label class="field iterationsField">
            <span class="label">最大迭代</span>
            <input
              v-model.number="bootstrapMaxIterationsModel"
              type="number"
              min="1"
              max="10"
              data-testid="task-edit-bootstrap-max-iterations"
            />
          </label>
        </div>

        <label class="field editPromptField">
          <span class="label">任务描述</span>
          <textarea v-model="promptModel" data-testid="task-edit-prompt" />
        </label>

        <div class="actions">
          <button class="btnSecondary" type="button" data-testid="task-edit-modal-cancel" @click="emit('close')">
            取消
          </button>
          <button
            v-if="props.showSaveButton"
            class="btnSecondary"
            type="button"
            :disabled="!props.task"
            data-testid="task-edit-modal-save"
            @click="emit('save')"
          >
            保存
          </button>
          <button
            class="btnPrimary"
            type="button"
            :disabled="!props.task"
            data-testid="task-edit-modal-save-and-run"
            @click="emit('saveAndRun')"
          >
            {{ props.primaryLabel }}
          </button>
        </div>
      </div>
    </div>
  </DraggableModal>
</template>

<style scoped>
.iconBtn {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  border: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: transparent;
  color: #64748b;
  box-shadow: none;
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.iconBtn:hover:not(:disabled) {
  color: #0f172a;
  background: rgba(15, 23, 42, 0.04);
}

.iconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.modalHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(248, 250, 252, 0.95);
}

@media (max-width: 9999px) {
  .modalHeader {
    display: none;
  }
}

.modalTitle {
  font-size: 18px;
  font-weight: 800;
  color: #0f172a;
  text-align: center;
  letter-spacing: 0.02em;
}

.modalTitle.main {
  margin: 0 0 2px 0;
}

.editModalInner {
  display: flex;
  flex-direction: column;
  height: min(680px, 80vh);
  overflow: hidden;
}

.modalBody {
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface);
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.modalBody .label {
  margin-bottom: 4px;
}

.modalBody input,
.modalBody select {
  padding: 8px 10px;
  font-size: 14px;
}

.field {
  display: block;
  min-width: 0;
}

.label {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 8px;
}

input,
select,
textarea {
  width: 100%;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--border);
  font-size: 15px;
  background: rgba(248, 250, 252, 0.95);
  color: #1e293b;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

input:hover,
select:hover,
textarea:hover {
  border-color: rgba(148, 163, 184, 0.8);
  background: rgba(255, 255, 255, 0.95);
}

input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.8);
  background: white;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

textarea {
  resize: none;
  min-height: 180px;
  max-height: none;
  overflow-y: auto;
}

.field.editPromptField {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.field.editPromptField textarea {
  flex: 1;
  resize: none;
  min-height: 120px;
  padding: 10px 12px;
  font-size: 14px;
}

.err {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  color: #dc2626;
}

.configRow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  align-items: end;
  flex-wrap: nowrap;
}

.configRowCheckboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  align-items: center;
}

.bootstrapToggle {
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
}

.bootstrapToggle input[type="checkbox"] {
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
  accent-color: #2563eb;
}

.checkboxLabel {
  display: inline;
  margin: 0 0 0 6px;
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
}

.projectField {
  flex: 1;
}

.iterationsField {
  width: 100px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 32px;
  margin-top: 12px;
}

.btnPrimary {
  border-radius: 14px;
  padding: 8px 12px;
  min-height: 38px;
  line-height: 1.1;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: none;
  background: linear-gradient(90deg, #4f8ef7 0%, #7aa9ff 100%);
  color: white;
  box-shadow: 0 10px 20px rgba(79, 142, 247, 0.35);
  transition: background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}

.btnPrimary:hover:not(:disabled) {
  transform: translateY(-1px);
}

.btnPrimary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  box-shadow: none;
}

.btnSecondary {
  border-radius: 14px;
  padding: 8px 12px;
  min-height: 38px;
  line-height: 1.1;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid rgba(79, 142, 247, 0.35);
  background: rgba(79, 142, 247, 0.12);
  color: #2563eb;
  transition: border-color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}

.btnSecondary:hover:not(:disabled) {
  border-color: rgba(79, 142, 247, 0.6);
  background: rgba(79, 142, 247, 0.18);
  transform: translateY(-1px);
}

.btnSecondary:active:not(:disabled) {
  background: rgba(79, 142, 247, 0.22);
}
</style>

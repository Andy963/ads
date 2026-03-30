<script setup lang="ts">
import DraggableModal from "../DraggableModal.vue";

import type {
  TaskBundleDraft,
  TaskBundleDraftSpecFileKey,
} from "../../api/types";
import type { EditingTask } from "./useDraftTaskEditor";

type EditorTab = "task" | TaskBundleDraftSpecFileKey;

const props = defineProps<{
  selectedDraft: TaskBundleDraft;
  busy?: boolean;
  editingError?: string | null;
  specError?: string | null;
  currentTabIsTask: boolean;
  currentSpecKey: TaskBundleDraftSpecFileKey | null;
  currentSpecStatusText: string;
  currentSpecMissing: boolean;
  currentSpecContent: string;
  activeTab: EditorTab;
  editingTask: EditingTask;
  originalTaskCount: number;
  taskDirty: boolean;
  taskNormalizationPending: boolean;
  specSummaryLoading: boolean;
  specBusy: Partial<Record<TaskBundleDraftSpecFileKey, "loading" | "saving">>;
  specDirty: Set<TaskBundleDraftSpecFileKey>;
  missingSpecFiles: string[];
  canSaveCurrentTab: boolean;
  canApproveDraft: boolean;
  draftTitle: (draft: TaskBundleDraft) => string;
  editorTabLabel: (tab: EditorTab) => string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "switch-tab", tab: EditorTab): void;
  (e: "reload"): void;
  (e: "update-task-prompt", value: string): void;
  (e: "update-spec-content", value: string): void;
  (e: "save-current-tab"): void;
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
      <div v-if="specError" class="modalError" data-testid="task-bundle-draft-spec-error">{{ specError }}</div>
      <div v-if="selectedDraft.degradeReason" class="modalWarning" data-testid="task-bundle-draft-degrade-reason">
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
          @click="emit('switch-tab', 'task')"
        >
          <span>Task</span>
          <span v-if="taskDirty || taskNormalizationPending" class="editorTabBadge">未保存</span>
        </button>
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'requirements', 'editorTab--dirty': specDirty.has('requirements') }"
          data-testid="task-bundle-draft-tab-requirements"
          @click="emit('switch-tab', 'requirements')"
        >
          <span>{{ editorTabLabel("requirements") }}</span>
          <span v-if="specDirty.has('requirements')" class="editorTabBadge">未保存</span>
        </button>
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'design', 'editorTab--dirty': specDirty.has('design') }"
          data-testid="task-bundle-draft-tab-design"
          @click="emit('switch-tab', 'design')"
        >
          <span>{{ editorTabLabel("design") }}</span>
          <span v-if="specDirty.has('design')" class="editorTabBadge">未保存</span>
        </button>
        <button
          type="button"
          class="editorTab"
          :class="{ 'editorTab--active': activeTab === 'implementation', 'editorTab--dirty': specDirty.has('implementation') }"
          data-testid="task-bundle-draft-tab-implementation"
          @click="emit('switch-tab', 'implementation')"
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
            @click="emit('reload')"
          >
            重新加载
          </button>
        </div>
      </div>

      <div class="editorViewport" data-testid="task-bundle-draft-viewport">
        <div v-if="currentTabIsTask" class="editorPanel editorPanel--task" data-testid="task-bundle-draft-task-panel">
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

        <div
          v-else-if="!selectedDraft.bundle?.specRef"
          class="specEmpty"
          data-testid="task-bundle-draft-spec-empty"
        >
          当前草稿还没有绑定 specRef，需先让 planner 生成或关联 spec。
        </div>

        <div
          v-else-if="specSummaryLoading || (currentSpecKey && specBusy[currentSpecKey] === 'loading' && currentSpecContent === '')"
          class="specEmpty"
          data-testid="task-bundle-draft-spec-loading"
        >
          正在加载当前标签…
        </div>

        <div v-else class="editorPanel editorPanel--spec" data-testid="task-bundle-draft-spec-panel">
          <textarea
            :value="currentSpecContent"
            class="fieldTextarea fieldTextarea--spec"
            rows="20"
            :disabled="currentSpecKey != null && specBusy[currentSpecKey] === 'loading'"
            :data-testid="`task-bundle-draft-spec-${currentSpecKey}`"
            @input="emit('update-spec-content', ($event.target as HTMLTextAreaElement).value)"
          />
        </div>
      </div>

      <div class="modalActions">
        <button type="button" class="btnSecondary" data-testid="task-bundle-draft-cancel" @click="emit('close')">取消</button>
        <button
          type="button"
          class="btnSecondary"
          :disabled="!canSaveCurrentTab"
          data-testid="task-bundle-draft-save-current-tab"
          @click="emit('save-current-tab')"
        >
          保存当前标签
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

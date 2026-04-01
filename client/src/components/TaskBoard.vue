<script setup lang="ts">
import { computed } from "vue";
import { Delete, Edit, Plus } from "@element-plus/icons-vue";
import type { ReviewSnapshot, Task, TaskQueueStatus } from "../api/types";
import type { ApiClient } from "../api/client";
import TaskBoardDetailModal from "./TaskBoardDetailModal.vue";
import TaskBoardReviewSnapshotModal from "./TaskBoardReviewSnapshotModal.vue";
import TaskBoardEditModal from "./TaskBoardEditModal.vue";
import { deriveTaskStage, type TaskStage } from "../lib/task_stage";
import {
  canEditTask,
  canRerunTask,
  canRunSingleTask,
  useTaskBoardEditing,
  type TaskUpdates,
} from "./taskBoard/useTaskBoardEditing";
import { usePendingTaskDnD } from "./taskBoard/usePendingTaskDnD";
import { useTaskBoardReviewSnapshot } from "./taskBoard/useTaskBoardReviewSnapshot";
import { reviewBadge, statusLabel, useTaskBoardStages } from "./taskBoard/useTaskBoardStages";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const props = defineProps<{
  tasks: Task[];
  api?: ApiClient;
  workspaceRoot?: string | null;
  agents?: AgentOption[];
  activeAgentId?: string;
  selectedId?: string | null;
  queueStatus?: TaskQueueStatus | null;
  canRunSingle?: boolean;
  runBusyIds?: Set<string>;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "create"): void;
  (e: "update", payload: { id: string; updates: TaskUpdates }): void;
  (e: "update-and-run", payload: { id: string; updates: TaskUpdates }): void;
  (e: "reorder", ids: string[]): void;
  (e: "queueRun"): void;
  (e: "queuePause"): void;
  (e: "runSingle", id: string): void;
  (e: "cancel", id: string): void;
  (e: "retry", id: string): void;
  (e: "markDone", id: string): void;
  (e: "delete", id: string): void;
}>();

const agentOptions = computed(() => {
  const raw = Array.isArray(props.agents) ? props.agents : [];
  return raw
    .map((a) => {
      const id = String(a?.id ?? "").trim();
      if (!id) return null;
      const name = String(a?.name ?? "").trim() || id;
      const ready = Boolean(a?.ready);
      const error = typeof a?.error === "string" && a.error.trim() ? a.error.trim() : undefined;
      return { id, name, ready, error } satisfies AgentOption;
    })
    .filter(Boolean) as AgentOption[];
});

const readyAgentOptions = computed(() => agentOptions.value.filter((a) => a.ready));

type TaskBoardAction = "reorder" | "runSingle" | "edit" | "rerun" | "cancel" | "retry" | "delete";

const ALLOWED_ACTIONS_BY_STAGE: Record<TaskStage, TaskBoardAction[]> = {
  backlog: ["reorder", "runSingle", "edit", "delete"],
  in_progress: ["cancel", "retry", "rerun", "delete"],
  in_review: ["delete"],
  done: ["delete"],
};

function isActionAllowed(task: Task, action: TaskBoardAction): boolean {
  const stage = deriveTaskStage(task);
  return ALLOWED_ACTIONS_BY_STAGE[stage].includes(action);
}

const queueStatus = computed(() => props.queueStatus ?? null);
const queueCanRunAll = computed(() => Boolean(queueStatus.value?.enabled) && Boolean(queueStatus.value?.ready));
const queueIsRunning = computed(() => Boolean(queueStatus.value?.running));
const canRunSingleNow = computed(() => {
  if (!props.canRunSingle) return false;
  if (!queueStatus.value) return true;
  if (!queueStatus.value.enabled || !queueStatus.value.ready) return false;
  return !queueStatus.value.running;
});

function isRunBusy(taskId: string): boolean {
  const id = String(taskId ?? "").trim();
  if (!id) return false;
  return props.runBusyIds?.has(id) ?? false;
}

const workspaceRoot = computed(() => props.workspaceRoot);
const tasksRef = computed(() => props.tasks);
const activeAgentId = computed(() => String(props.activeAgentId ?? "").trim());

const {
  stageBuckets,
  stageSections,
  totalVisibleTasks,
  stageCollapsed,
  toggleStageCollapse,
  taskColorVars,
} = useTaskBoardStages({
  tasks: tasksRef,
  workspaceRoot,
});

const {
  detailId,
  detailTask,
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
} = useTaskBoardReviewSnapshot({
  tasks: tasksRef,
  api: computed(() => props.api),
  workspaceRoot,
});

const {
  editingId,
  editingTask,
  editTitle,
  editPrompt,
  editAgentId,
  editPriority,
  editMaxRetries,
  editReviewRequired,
  editBootstrapEnabled,
  editBootstrapProject,
  editBootstrapMaxIterations,
  error,
  editAgentOptions,
  editPrimaryLabel,
  showEditSaveButton,
  startEdit,
  stopEdit,
  saveEdit,
  saveEditAndRun,
} = useTaskBoardEditing({
  tasks: tasksRef,
  readyAgentOptions,
  activeAgentId,
  emitUpdate: (payload) => emit("update", payload),
  emitUpdateAndRun: (payload) => emit("update-and-run", payload),
});

const pendingBacklogIds = computed(() =>
  stageBuckets.value.backlog.filter((task) => task.status === "pending").map((task) => task.id),
);
const canReorderPending = computed(() => pendingBacklogIds.value.length > 1 && !queueIsRunning.value);

const {
  dropTargetPendingTaskId,
  dropTargetPosition,
  shouldSuppressTaskRowClick,
  canDragPendingTask,
  onPendingTaskDragStart,
  onPendingTaskDragEnd,
  onPendingTaskDragOver,
  onPendingTaskDrop,
} = usePendingTaskDnD({
  pendingBacklogIds,
  canReorderPending,
  emitReorder: (ids) => emit("reorder", ids),
  allowReorderAction: (task) => isActionAllowed(task, "reorder"),
});

function onTaskRowClick(taskId: string): void {
  if (shouldSuppressTaskRowClick()) return;
  emit("select", taskId);
  if (editingId.value) return;
  detailId.value = taskId;
}

function toggleQueue(): void {
  if (!queueStatus.value) return;
  if (!queueCanRunAll.value) return;
  emit(queueIsRunning.value ? "queuePause" : "queueRun");
}
</script>

<template>
  <div class="card">
    <div class="header">
      <div class="headerLeft">
        <h3 class="title">任务列表</h3>
      </div>
      <div class="headerRight">
        <div v-if="queueStatus" class="queueControls">
          <span class="queueDot" :class="{ on: queueIsRunning }" :title="queueIsRunning ? '队列运行中' : '队列已暂停'" />
          <button class="iconBtn" :class="queueIsRunning ? 'danger' : 'primary'" type="button"
            :disabled="!queueCanRunAll" :title="queueIsRunning ? '暂停队列' : '运行队列'" aria-label="切换任务队列"
            @click.stop="toggleQueue">
            <svg v-if="queueIsRunning" width="16" height="16" viewBox="0 0 20 20" fill="currentColor"
              aria-hidden="true">
              <path d="M6 4h2v12H6V4Zm6 0h2v12h-2V4Z" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M7 4.5v11l9-5.5-9-5.5Z" />
            </svg>
          </button>
        </div>
        <button
          class="iconBtn primary"
          type="button"
          title="新建任务"
          aria-label="新建任务"
          data-testid="task-board-create"
          @click.stop="emit('create')"
        >
          <el-icon :size="16" aria-hidden="true" class="icon">
            <Plus />
          </el-icon>
        </button>
      </div>
    </div>

    <div v-if="totalVisibleTasks === 0" class="empty">
      <span>暂无任务</span>
      <span class="hint">点击 + 新建任务</span>
    </div>

    <div v-else class="list">
      <div class="mindmap">
        <div v-for="section in stageSections" :key="section.stage" class="stage" :data-stage="section.stage"
          :data-testid="section.testId">
          <button class="stageHeader" type="button" @click="toggleStageCollapse(section.stage)">
            <span class="stageTitle">
              <svg class="stageToggleIcon" :class="{ collapsed: stageCollapsed[section.stage] }" width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
              </svg>
              {{ section.title }}
            </span>
            <span class="stageCount">{{ section.tasks.length }}</span>
          </button>

          <TransitionGroup v-if="section.tasks.length > 0 && !stageCollapsed[section.stage]" name="task-list" tag="div" class="stageList">
            <div v-for="t in section.tasks" :key="t.id" class="item" :data-stage="section.stage" :data-status="t.status"
              :data-task-id="t.id" :class="{
                active: t.id === selectedId,
                dropBefore: dropTargetPendingTaskId === t.id && dropTargetPosition === 'before',
                dropAfter: dropTargetPendingTaskId === t.id && dropTargetPosition === 'after',
              }" :style="taskColorVars(t)" @dragover="(ev) => onPendingTaskDragOver(ev, t.id)"
              @drop="(ev) => onPendingTaskDrop(ev, t.id)">
              <div class="row">
                <button class="row-main" type="button" @click="onTaskRowClick(t.id)">
                  <div class="row-top">
                    <div class="row-head">
                      <span class="row-title" :title="statusLabel(t.status)">{{ t.title || "(未命名任务)" }}</span>
                      <span v-if="reviewBadge(t)" class="badge" :data-review="reviewBadge(t)!.status"
                        :title="reviewBadge(t)!.title">
                        {{ reviewBadge(t)!.label }}
                      </span>
                    </div>
                  </div>
                </button>
                <div class="row-actions">
                  <button v-if="canDragPendingTask(t)" class="iconBtn taskDragHandle" type="button" title="拖拽排序"
                    aria-label="拖拽排序" data-testid="task-drag-handle" draggable="true"
                    @dragstart="(ev) => onPendingTaskDragStart(ev, t.id)" @dragend="onPendingTaskDragEnd"
                    @click.stop.prevent @mousedown.stop>
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M4 6h12v2H4V6zm0 5h12v2H4v-2zm0 5h12v2H4v-2z" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'runSingle') && canRunSingleTask(t)" class="iconBtn primary"
                    type="button" :disabled="!canRunSingleNow || isRunBusy(t.id)"
                    :title="queueIsRunning ? '请先暂停队列，再单独运行' : '单独运行该任务'" aria-label="单独运行任务"
                    @click.stop="emit('runSingle', t.id)">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M7 4.5v11l9-5.5-9-5.5Z" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'rerun') && canRerunTask(t) && editingId !== t.id"
                    class="iconBtn primary" type="button" title="重新执行" :disabled="Boolean(editingId)"
                    @click.stop="startEdit(t)">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd"
                        d="M10 3a7 7 0 1 0 7 7 .75.75 0 0 0-1.5 0 5.5 5.5 0 1 1-1.38-3.65l-1.62 1.6a.75.75 0 0 0 .53 1.28H17a.75.75 0 0 0 .75-.75V3.5a.75.75 0 0 0-1.28-.53l-1.13 1.12A6.98 6.98 0 0 0 10 3Z"
                        clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'edit') && canEditTask(t) && !canRerunTask(t) && editingId !== t.id"
                    class="iconBtn" type="button" title="编辑" :disabled="Boolean(editingId)" data-testid="task-edit"
                    @click.stop="startEdit(t)">
                    <el-icon :size="16" aria-hidden="true" class="icon">
                      <Edit />
                    </el-icon>
                  </button>
                  <button v-if="editingId === t.id" class="iconBtn" type="button" title="取消编辑"
                    @click.stop="stopEdit()">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd"
                        d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                        clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'cancel') && (t.status === 'running' || t.status === 'planning')"
                    class="iconBtn danger" type="button" title="终止任务" @click.stop="emit('cancel', t.id)">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <rect x="4" y="4" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'retry') && t.status === 'failed'" class="iconBtn" type="button"
                    title="重试" @click.stop="emit('retry', t.id)">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd"
                        d="M10 4a6 6 0 0 0-5.2 9h2.1a1 1 0 0 1 .8 1.6l-2.4 3.2a1 1 0 0 1-1.6 0l-2.4-3.2A1 1 0 0 1 2.1 13h1.2A8 8 0 1 1 10 18a.75.75 0 0 1 0-1.5A6.5 6.5 0 1 0 3.62 10a.75.75 0 1 1-1.5 0A8 8 0 0 1 10 2a.75.75 0 0 1 0 1.5Z"
                        clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'delete')" class="iconBtn danger" type="button" title="删除任务"
                    :disabled="t.status === 'running' || t.status === 'planning'" @click.stop="emit('delete', t.id)">
                    <el-icon :size="16" aria-hidden="true" class="icon">
                      <Delete />
                    </el-icon>
                  </button>
                </div>
              </div>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </div>

    <TaskBoardDetailModal
      v-if="detailTask"
      :task="detailTask"
      :status-label="statusLabel(detailTask.status)"
      :reviewed-at-text="formatTs(detailTask.reviewedAt)"
      :review-badge="reviewBadge(detailTask)"
      :can-mark-review-done="canMarkReviewDone"
      :can-view-review-notes="canViewReviewNotes"
      :show-task-prompt="showTaskPromptInDetail"
      @close="closeDetail"
      @mark-done="emit('markDone', $event)"
      @view-review-notes="openReviewSnapshot"
    />

    <TaskBoardReviewSnapshotModal
      v-if="reviewSnapshotOpen"
      :task-id="detailTask?.id ?? null"
      :snapshot-id="detailTask?.reviewSnapshotId ?? null"
      :snapshot="reviewSnapshot"
      :busy="reviewSnapshotBusy"
      :error="reviewSnapshotError"
      @close="closeReviewSnapshot"
    />

    <TaskBoardEditModal
      v-if="editingTask"
      :task="editingTask"
      :error="error"
      :title="editTitle"
      :prompt="editPrompt"
      :agent-id="editAgentId"
      :priority="editPriority"
      :max-retries="editMaxRetries"
      :review-required="editReviewRequired"
      :bootstrap-enabled="editBootstrapEnabled"
      :bootstrap-project="editBootstrapProject"
      :bootstrap-max-iterations="editBootstrapMaxIterations"
      :agent-options="editAgentOptions"
      :show-save-button="showEditSaveButton"
      :primary-label="editPrimaryLabel"
      @close="stopEdit"
      @save="saveEdit(editingTask)"
      @save-and-run="saveEditAndRun(editingTask)"
      @update:title="editTitle = $event"
      @update:prompt="editPrompt = $event"
      @update:agent-id="editAgentId = $event"
      @update:priority="editPriority = $event"
      @update:max-retries="editMaxRetries = $event"
      @update:review-required="editReviewRequired = $event"
      @update:bootstrap-enabled="editBootstrapEnabled = $event"
      @update:bootstrap-project="editBootstrapProject = $event"
      @update:bootstrap-max-iterations="editBootstrapMaxIterations = $event"
    />
  </div>
</template>
<style src="./TaskBoard.css" scoped></style>

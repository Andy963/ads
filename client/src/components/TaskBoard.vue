<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Delete, Edit, Plus } from "@element-plus/icons-vue";
import type { ReviewAutomationMode, ReviewSettings, Task, TaskDetail, TaskQueueStatus } from "../api/types";
import type { ApiClient } from "../api/client";
import TaskBoardDetailModal from "./TaskBoardDetailModal.vue";
import TaskBoardEditModal from "./TaskBoardEditModal.vue";
import { deriveTaskStage, type TaskStage } from "../lib/task_stage";
import {
  canEditTask,
  canRerunTask,
  canRunSingleTask,
  useTaskBoardEditing,
  type TaskUpdates,
  type TaskSaveResult,
} from "./taskBoard/useTaskBoardEditing";
import { usePendingTaskDnD } from "./taskBoard/usePendingTaskDnD";
import { statusLabel, taskCategoryLabel, useTaskBoardStages } from "./taskBoard/useTaskBoardStages";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

const props = withDefaults(
  defineProps<{
    tasks: Task[];
    api?: ApiClient;
    workspaceRoot?: string | null;
    agents?: AgentOption[];
    activeAgentId?: string;
    selectedId?: string | null;
    queueStatus?: TaskQueueStatus | null;
    canRunSingle?: boolean;
    runBusyIds?: Set<string>;
    showCreateButton?: boolean;
    updateTask?: (payload: { id: string; updates: TaskUpdates }) => Promise<TaskSaveResult>;
    updateTaskAndRun?: (payload: { id: string; updates: TaskUpdates }) => Promise<TaskSaveResult>;
  }>(),
  {
    showCreateButton: true,
  },
);

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
  (e: "delete", id: string): void;
  (e: "goal-pause", id: string): void;
  (e: "goal-resume", id: string): void;
  (e: "goal-clear", id: string): void;
  (e: "review-action", payload: { taskId: string; action: "force_approve" | "edit_rework" | "skip_review" | "abort"; feedback?: string; reason?: string }): void;
  (e: "review-navigate", taskId: string): void;
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

const detailId = ref<string | null>(null);
const detailData = ref<TaskDetail | null>(null);
const detailLoading = ref(false);
const detailTask = computed<Task | null>(() => {
  const id = String(detailId.value ?? "").trim();
  if (!id) return null;
  const compact = props.tasks.find((task) => task.id === id) ?? null;
  if (!compact) return null;
  if (detailData.value?.id !== id) return compact;
  return { ...compact, ...detailData.value };
});

function closeDetail(): void {
  detailId.value = null;
  detailData.value = null;
}

async function loadTaskDetail(taskId: string): Promise<void> {
  if (!props.api || !String(props.workspaceRoot ?? "").trim()) return;
  const id = String(taskId ?? "").trim();
  if (!id) return;
  detailLoading.value = true;
  try {
    const workspace = encodeURIComponent(String(props.workspaceRoot).trim());
    const detail = await props.api.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}?workspace=${workspace}`);
    if (detailId.value === id) detailData.value = detail;
  } catch {
    // The compact task remains usable when the detail request fails.
  } finally {
    if (detailId.value === id) detailLoading.value = false;
  }
}

const {
  editingId,
  editingTask,
  editTitle,
  editPrompt,
  editAgentId,
  editPriority,
  editMaxRetries,
  error,
  saving,
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
  persistUpdate: async (payload) => {
    if (props.updateTask) return await props.updateTask(payload);
    emit("update", payload);
    return { ok: true };
  },
  persistUpdateAndRun: async (payload) => {
    if (props.updateTaskAndRun) return await props.updateTaskAndRun(payload);
    emit("update-and-run", payload);
    return { ok: true };
  },
});

watch(workspaceRoot, (next, previous) => {
  if (previous !== undefined && next !== previous && editingId.value) stopEdit();
});

watch(tasksRef, (nextTasks) => {
  const id = editingId.value;
  if (id && !nextTasks.some((task) => task.id === id)) stopEdit();
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
  detailData.value = null;
  void loadTaskDetail(taskId);
}

function onReviewNavigate(taskId: string): void {
  onTaskRowClick(taskId);
}

const reviewSettings = ref<ReviewSettings | null>(null);
const reviewSettingsBusy = ref(false);
const reviewSettingsError = ref<string | null>(null);

async function loadReviewSettings(): Promise<void> {
  if (!props.api || !String(props.workspaceRoot ?? "").trim()) {
    reviewSettings.value = null;
    return;
  }
  try {
    const workspace = encodeURIComponent(String(props.workspaceRoot).trim());
    reviewSettings.value = await props.api.get<ReviewSettings>(`/api/review-settings?workspace=${workspace}`);
    reviewSettingsError.value = null;
  } catch (error) {
    reviewSettingsError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveReviewSettings(patch: Partial<ReviewSettings>): Promise<void> {
  if (!props.api || !String(props.workspaceRoot ?? "").trim() || reviewSettingsBusy.value) return;
  reviewSettingsBusy.value = true;
  reviewSettingsError.value = null;
  try {
    const workspace = encodeURIComponent(String(props.workspaceRoot).trim());
    reviewSettings.value = await props.api.patch<ReviewSettings>(`/api/review-settings?workspace=${workspace}`, patch);
  } catch (error) {
    reviewSettingsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    reviewSettingsBusy.value = false;
  }
}

function onReviewModeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value;
  if (value === "auto_with_fuse" || value === "human_gated") {
    void saveReviewSettings({ automationMode: value as ReviewAutomationMode });
  }
}

function onReviewRoundsChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement | null)?.value);
  if (Number.isInteger(value) && value >= 0) void saveReviewSettings({ maxReworkRounds: value });
}

watch(workspaceRoot, () => {
  void loadReviewSettings();
}, { immediate: true });

function toggleQueue(): void {
  if (!queueStatus.value) return;
  if (!queueCanRunAll.value) return;
  emit(queueIsRunning.value ? "queuePause" : "queueRun");
}

function reviewStatusLabel(task: Task): string {
  switch (task.review?.status) {
    case "pending_review": return "待审核";
    case "in_review": return "审核中";
    case "approved": return "已通过";
    case "rejected": return "已拒绝";
    case "needs_human_intervention": return "需人工处理";
    case "skipped": return "已跳过";
    case "error": return "审核错误";
    default: return "";
  }
}

function canUseReviewControls(task: Task): boolean {
  return Boolean(task.review?.required)
    && ["rejected", "needs_human_intervention", "error", "pending_review", "in_review"].includes(task.review?.status ?? "");
}

function emitReviewAction(task: Task, action: "force_approve" | "edit_rework" | "skip_review" | "abort"): void {
  if (!canUseReviewControls(task)) return;
  const destructive = action === "abort" || action === "skip_review";
  if (destructive && !window.confirm(action === "abort" ? "Abort this review chain?" : "Skip this review?")) return;
  emit("review-action", { taskId: task.id, action, feedback: task.review?.feedback ?? undefined });
}
</script>

<template>
  <div class="card">
    <div class="header">
      <div class="headerLeft">
        <h3 class="title">任务列表</h3>
        <span v-if="detailLoading" class="reviewSettingsLoading">加载详情…</span>
        <div v-if="reviewSettings" class="reviewSettings" data-testid="review-settings">
          <label class="reviewSettingsLabel">
            审核模式
            <select :value="reviewSettings.automationMode" :disabled="reviewSettingsBusy" @change="onReviewModeChange">
              <option value="auto_with_fuse">Auto with Fuse</option>
              <option value="human_gated">Human-Gated</option>
            </select>
          </label>
          <label class="reviewSettingsLabel">
            自动返工上限
            <input
              type="number"
              min="0"
              step="1"
              :value="reviewSettings.maxReworkRounds"
              :disabled="reviewSettingsBusy"
              @change="onReviewRoundsChange"
            />
          </label>
          <span v-if="reviewSettingsError" class="reviewSettingsError" :title="reviewSettingsError">设置失败</span>
        </div>
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
          v-if="props.showCreateButton"
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
      <span v-if="props.showCreateButton" class="hint">点击 + 新建任务</span>
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
                      <span class="taskCategoryBadge" :data-category="t.category ?? 'development'">
                        {{ taskCategoryLabel(t.category) }}
                      </span>
                      <span class="taskPriorityBadge" :data-priority="t.priority">P{{ t.priority }}</span>
                      <span
                        v-if="t.review?.required && reviewStatusLabel(t)"
                        class="reviewBadge"
                        :data-review-status="t.review.status"
                        :title="t.review.stateReason ?? reviewStatusLabel(t)"
                      >{{ reviewStatusLabel(t) }}</span>
                      <a
                        v-if="t.review?.pullRequestNumber"
                        class="reviewPrLink"
                        :href="t.review.pullRequestUrl ?? undefined"
                        target="_blank"
                        rel="noreferrer"
                        @click.stop
                      >PR #{{ t.review.pullRequestNumber }}</a>
                      <span v-if="t.review?.required && t.review.reviewerModelDisplayName" class="reviewModelBadge">
                        {{ t.review.reviewerModelDisplayName }}
                      </span>
                      <span v-if="t.review?.required && t.review.maxReworkRounds > 0" class="reviewRoundBadge">
                        Rework {{ t.review.reworkRound }}/{{ t.review.maxReworkRounds }}
                      </span>
                      <span
                        v-if="t.goalMode"
                        class="goalBadge"
                        :data-goal-status="t.goalStatus ?? 'none'"
                        :title="`Goal Mode: ${t.goalStatus ?? '未启动'}`"
                      >🎯</span>
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
                <div v-if="canUseReviewControls(t)" class="reviewCardActions" @click.stop>
                  <button type="button" class="reviewActionButton" data-testid="review-force-approve" @click="emitReviewAction(t, 'force_approve')">Force Approve</button>
                  <button type="button" class="reviewActionButton" data-testid="review-edit-rework" @click="onTaskRowClick(t.id)">Edit &amp; Rework</button>
                  <button type="button" class="reviewActionButton" data-testid="review-skip" @click="emitReviewAction(t, 'skip_review')">Skip Review</button>
                  <button type="button" class="reviewActionButton danger" data-testid="review-abort" @click="emitReviewAction(t, 'abort')">Abort</button>
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
      :category-label="taskCategoryLabel(detailTask.category)"
      @close="closeDetail"
      @goal-pause="(id) => emit('goal-pause', id)"
      @goal-resume="(id) => emit('goal-resume', id)"
      @goal-clear="(id) => emit('goal-clear', id)"
      @review-action="(payload) => emit('review-action', payload)"
      @review-navigate="onReviewNavigate"
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
      :agent-options="editAgentOptions"
      :show-save-button="showEditSaveButton"
      :primary-label="editPrimaryLabel"
      :saving="saving"
      @close="stopEdit"
      @save="void saveEdit(editingTask)"
      @save-and-run="void saveEditAndRun(editingTask)"
      @update:title="editTitle = $event"
      @update:prompt="editPrompt = $event"
      @update:agent-id="editAgentId = $event"
      @update:priority="editPriority = $event"
      @update:max-retries="editMaxRetries = $event"
    />
  </div>
</template>
<style src="./TaskBoard.css" scoped></style>

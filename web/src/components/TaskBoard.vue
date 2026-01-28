<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ModelConfig, PlanStep, Task, TaskQueueStatus } from "../api/types";

type TaskUpdates = Partial<Pick<Task, "title" | "prompt" | "model" | "priority" | "inheritContext" | "maxRetries">>;

const props = defineProps<{
  tasks: Task[];
  models: ModelConfig[];
  selectedId?: string | null;
  plans: Map<string, PlanStep[]>;
  expanded: Set<string>;
  queueStatus?: TaskQueueStatus | null;
  canRunSingle?: boolean;
  runBusyIds?: Set<string>;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "create"): void;
  (e: "resetThread"): void;
  (e: "togglePlan", id: string): void;
  (e: "ensurePlan", id: string): void;
  (e: "update", payload: { id: string; updates: TaskUpdates }): void;
  (e: "queueRun"): void;
  (e: "queuePause"): void;
  (e: "runSingle", id: string): void;
  (e: "cancel", id: string): void;
  (e: "retry", id: string): void;
  (e: "delete", id: string): void;
}>();

const modelOptions = computed(() => {
  const enabled = props.models.filter((m) => m.isEnabled);
  return [{ id: "auto", displayName: "Auto", provider: "" }, ...enabled];
});

const modelLabelById = computed(() => new Map(modelOptions.value.map((m) => [m.id, m.displayName])));

function formatModel(id: string | null | undefined): string {
  const raw = String(id ?? "").trim();
  if (!raw) return "Auto";
  return modelLabelById.value.get(raw) ?? raw;
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待启动";
    case "planning":
      return "规划中";
    case "running":
      return "执行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function formatPromptPreview(prompt: string, maxChars = 90): string {
  const normalized = String(prompt ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

const sorted = computed(() => {
  const weight = (s: string) => (s === "running" ? 0 : s === "planning" ? 1 : s === "pending" ? 2 : 3);
  return props.tasks
    .slice()
    .sort((a, b) => {
      const wa = weight(a.status);
      const wb = weight(b.status);
      if (wa !== wb) return wa - wb;
      if (a.status !== b.status) return a.status.localeCompare(b.status);
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.createdAt - a.createdAt;
    });
});

const editingId = ref<string | null>(null);
const editTitle = ref("");
const editPrompt = ref("");
const editModel = ref("auto");
const editPriority = ref(0);
const editMaxRetries = ref(3);
const editInheritContext = ref(true);
const error = ref<string | null>(null);
const editTitleEl = ref<HTMLInputElement | null>(null);

const editingTask = computed(() => {
  const id = String(editingId.value ?? "").trim();
  if (!id) return null;
  return props.tasks.find((t) => t.id === id) ?? null;
});

function startEdit(task: Task): void {
  if (editingId.value) return;
  editingId.value = task.id;
  editTitle.value = task.title ?? "";
  editPrompt.value = task.prompt ?? "";
  editModel.value = task.model ?? "auto";
  editPriority.value = task.priority ?? 0;
  editMaxRetries.value = task.maxRetries ?? 3;
  editInheritContext.value = task.inheritContext ?? true;
  error.value = null;
  void nextTick(() => {
    editTitleEl.value?.focus();
  });
}

function stopEdit(): void {
  editingId.value = null;
  error.value = null;
}

function saveEdit(task: Task): void {
  const title = editTitle.value.trim();
  const prompt = editPrompt.value.trim();
  if (!title) {
    error.value = "标题不能为空";
    return;
  }
  if (!prompt) {
    error.value = "Task description cannot be empty.";
    return;
  }

  emit("update", {
    id: task.id,
    updates: {
      title,
      prompt,
      model: editModel.value,
      priority: Number.isFinite(editPriority.value) ? editPriority.value : 0,
      maxRetries: Number.isFinite(editMaxRetries.value) ? editMaxRetries.value : 3,
      inheritContext: Boolean(editInheritContext.value),
    },
  });
  stopEdit();
}

function canShowPlan(task: Task): boolean {
  return task.status !== "pending";
}

function togglePlan(task: Task): void {
  if (!canShowPlan(task)) return;
  emit("togglePlan", task.id);
  if (!props.plans.get(task.id)?.length) {
    emit("ensurePlan", task.id);
  }
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

function canRunSingleTask(task: Task): boolean {
  const status = task.status;
  return status === "pending" || status === "queued" || status === "paused";
}

function toggleQueue(): void {
  if (!queueStatus.value) return;
  if (!queueCanRunAll.value) return;
  emit(queueIsRunning.value ? "queuePause" : "queueRun");
}

const listEl = ref<HTMLElement | null>(null);

function escapeCssValue(v: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(v);
  return v.replace(/["\\\\]/g, "\\\\$&");
}

function scrollPlanIntoView(taskId: string): void {
  const list = listEl.value;
  if (!list) return;

  const selector = `[data-task-id="${escapeCssValue(taskId)}"] .plan`;
  const plan = list.querySelector(selector) as HTMLElement | null;
  if (!plan) return;

  const listRect = list.getBoundingClientRect();
  const planRect = plan.getBoundingClientRect();

  if (planRect.bottom > listRect.bottom) {
    const delta = planRect.bottom - listRect.bottom;
    list.scrollTo?.({ top: list.scrollTop + delta });
    if (!("scrollTo" in list)) {
      list.scrollTop += delta;
    }
  } else if (planRect.top < listRect.top) {
    const delta = planRect.top - listRect.top;
    list.scrollTo?.({ top: list.scrollTop + delta });
    if (!("scrollTo" in list)) {
      list.scrollTop += delta;
    }
  }
}

watch(
  () => props.expanded,
  async (next, prev) => {
    const prevSet = prev ?? new Set<string>();
    const added = Array.from(next).filter((id) => !prevSet.has(id));
    if (!added.length) return;
    await nextTick();
    scrollPlanIntoView(added[0]);
  },
  { flush: "post" },
);
</script>

<template>
  <div class="card">
    <div class="header">
      <div class="headerLeft">
        <h3 class="title">任务列表</h3>
        <span class="count">{{ tasks.length }}</span>
      </div>
      <div class="headerRight">
        <div v-if="queueStatus" class="queueControls">
          <span class="queueDot" :class="{ on: queueIsRunning }" :title="queueIsRunning ? 'Queue running' : 'Queue paused'" />
          <button
            class="iconBtn"
            :class="queueIsRunning ? 'danger' : 'primary'"
            type="button"
            :disabled="!queueCanRunAll"
            :title="queueIsRunning ? 'Pause queue' : 'Run queue'"
            aria-label="Toggle task queue"
            @click.stop="toggleQueue"
          >
            <svg v-if="queueIsRunning" width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6 4h2v12H6V4Zm6 0h2v12h-2V4Z" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M7 4.5v11l9-5.5-9-5.5Z" />
            </svg>
          </button>
        </div>
        <button class="iconBtn primary" type="button" title="Create task" aria-label="Create task" @click.stop="emit('create')">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M10 4v12" />
            <path d="M4 10h12" />
          </svg>
        </button>
        <button class="iconBtn" type="button" title="Reset thread" aria-label="Reset thread" @click.stop="emit('resetThread')">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 4v5h5" />
            <path d="M16 16v-5h-5" />
            <path d="M5.5 14.5a6 6 0 0 0 8.5 0" />
            <path d="M14.5 5.5a6 6 0 0 0-8.5 0" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="tasks.length === 0" class="empty">
      <span>暂无任务</span>
      <span class="hint">Click + to create a task</span>
    </div>

    <div v-else ref="listEl" class="list">
        <div
          v-for="t in sorted"
          :key="t.id"
          class="item"
          :data-status="t.status"
          :data-task-id="t.id"
          :class="{ active: t.id === selectedId, expanded: expanded.has(t.id) && canShowPlan(t) }"
        >
        <div class="row">
          <button class="row-main" type="button" @click="emit('select', t.id)">
            <div class="row-top">
              <div class="row-head">
                <span class="row-title" :title="statusLabel(t.status)">{{ t.title || "(未命名任务)" }}</span>
              </div>
            </div>
            <div class="row-sub">
              <div class="tags">
                <span class="tag mono">#{{ t.id.slice(0, 8) }}</span>
                <span class="tag">{{ formatModel(t.model) }}</span>
                <span v-if="t.priority > 0" class="tag">P{{ t.priority }}</span>
              </div>
              <span v-if="t.prompt && t.prompt.trim()" class="preview" :title="t.prompt">
                {{ formatPromptPreview(t.prompt) }}
              </span>
            </div>
            <div v-if="t.attachments?.length" class="attachmentsRow">
              <a
                v-for="a in t.attachments.slice(0, 4)"
                :key="a.id"
                class="attachmentLink"
                :href="a.url"
                target="_blank"
                rel="noreferrer"
                :title="a.filename || a.id"
                @click.stop
              >
                {{ a.filename || a.id }}
              </a>
              <span v-if="t.attachments.length > 4" class="attachmentsMore">+{{ t.attachments.length - 4 }}</span>
            </div>
          </button>
          <div class="row-actions">
            <button
              v-if="canRunSingleTask(t)"
              class="iconBtn primary"
              type="button"
              :disabled="!canRunSingleNow || isRunBusy(t.id)"
              :title="queueIsRunning ? 'Pause queue to run a single task' : 'Run this task'"
              aria-label="Run single task"
              @click.stop="emit('runSingle', t.id)"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M7 4.5v11l9-5.5-9-5.5Z" />
              </svg>
            </button>
            <button
              v-if="t.status === 'pending' && editingId !== t.id"
              class="iconBtn"
              type="button"
              title="编辑"
              :disabled="Boolean(editingId)"
              data-testid="task-edit"
              @click.stop="startEdit(t)"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M13.59 2.59a2 2 0 0 1 2.82 2.82l-8.7 8.7a2 2 0 0 1-.88.5l-3.15.9a1 1 0 0 1-1.24-1.24l.9-3.15a2 2 0 0 1 .5-.88l8.7-8.7Zm1.41 1.41a.5.5 0 0 0-.7 0l-1.3 1.3 1.7 1.7 1.3-1.3a.5.5 0 0 0 0-.7L15 4Zm-2.36 2.36-7.68 7.68-.5 1.76 1.76-.5 7.68-7.68-1.26-1.26Z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button v-if="t.status === 'pending' && editingId === t.id" class="iconBtn" type="button" title="取消编辑" @click.stop="stopEdit()">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button
              v-if="t.status === 'running' || t.status === 'planning'"
              class="iconBtn danger"
              type="button"
              title="终止任务"
              @click.stop="emit('cancel', t.id)"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M6 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6Zm0 2h8v8H6V6Z" clip-rule="evenodd" />
              </svg>
            </button>
            <button v-if="t.status === 'failed'" class="iconBtn" type="button" title="重试" @click.stop="emit('retry', t.id)">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M10 4a6 6 0 0 0-5.2 9h2.1a1 1 0 0 1 .8 1.6l-2.4 3.2a1 1 0 0 1-1.6 0l-2.4-3.2A1 1 0 0 1 2.1 13h1.2A8 8 0 1 1 10 18a.75.75 0 0 1 0-1.5A6.5 6.5 0 1 0 3.62 10a.75.75 0 1 1-1.5 0A8 8 0 0 1 10 2a.75.75 0 0 1 0 1.5Z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button v-if="canShowPlan(t)" class="iconBtn" type="button" :title="expanded.has(t.id) ? '收起 Plan' : '展开 Plan'" @click="togglePlan(t)">
              <svg v-if="expanded.has(t.id)" width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 12.21a.75.75 0 0 1 .02-1.06l4.22-4.06a.75.75 0 0 1 1.06.02l4.24 4.38a.75.75 0 1 1-1.08 1.04L10 8.71l-3.73 3.59a.75.75 0 0 1-1.06-.02Z" clip-rule="evenodd" />
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M14.77 7.79a.75.75 0 0 1-.02 1.06l-4.22 4.06a.75.75 0 0 1-1.06-.02L5.23 8.51a.75.75 0 0 1 1.08-1.04L10 11.29l3.73-3.59a.75.75 0 0 1 1.06.02Z" clip-rule="evenodd" />
              </svg>
            </button>
            <button class="iconBtn danger" type="button" title="删除任务" :disabled="t.status === 'running' || t.status === 'planning'" @click.stop="emit('delete', t.id)">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M7 3a1 1 0 0 0-1 1v1H4.75a.75.75 0 0 0 0 1.5h.7l.62 9.1A2 2 0 0 0 8.06 18h3.88a2 2 0 0 0 2-1.9l.62-9.1h.69a.75.75 0 0 0 0-1.5H14V4a1 1 0 0 0-1-1H7Zm1.5 2V4.5h3V5H8.5Zm-1.55 2.5.56 8.25c.03.43.39.75.82.75h3.34c.43 0 .79-.32.82-.75l.56-8.25H6.95Z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="expanded.has(t.id) && canShowPlan(t)" class="plan">
          <div v-if="!(plans.get(t.id)?.length)" class="plan-empty">计划生成中…</div>
          <div v-else class="plan-rows">
            <div v-for="s in plans.get(t.id)" :key="s.id" class="plan-row" :data-status="s.status">
              <span class="plan-step">{{ s.stepNumber }}.</span>
              <span class="plan-title" :title="s.title">{{ s.title }}</span>
              <span class="plan-status" :data-status="s.status">
                <span v-if="s.status === 'completed'" class="ok">✓</span>
                <span v-else-if="s.status === 'running'" class="run"></span>
                <span v-else class="wait"></span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="editingTask" class="modalOverlay" role="dialog" aria-modal="true" data-testid="task-edit-modal" @click.self="stopEdit">
      <div class="modalCard">
        <div class="modalHeader">
          <div class="modalTitle">Edit task</div>
          <button class="iconBtn" type="button" aria-label="Close" title="Close" data-testid="task-edit-modal-cancel" @click="stopEdit">
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
          <div class="modalTitle main">编辑任务</div>
          <div v-if="error" class="err">{{ error }}</div>

          <label class="field">
            <span class="label">标题</span>
            <input ref="editTitleEl" v-model="editTitle" />
          </label>

          <div class="configRow">
            <div class="grid">
              <label class="field">
                <span class="label">模型</span>
                <select v-model="editModel">
                  <option v-for="m in modelOptions" :key="m.id" :value="m.id">
                    {{ m.displayName }}{{ m.provider ? ` (${m.provider})` : "" }}
                  </option>
                </select>
              </label>
              <label class="field">
                <span class="label">优先级</span>
                <input v-model.number="editPriority" type="number" />
              </label>
              <label class="field">
                <span class="label">最大重试</span>
                <input v-model.number="editMaxRetries" type="number" min="0" />
              </label>
            </div>

            <label class="check">
              <input v-model="editInheritContext" type="checkbox" />
              <span>继承上下文</span>
            </label>
          </div>

          <label class="field">
            <span class="label">任务描述</span>
            <textarea v-model="editPrompt" rows="6" data-testid="task-edit-prompt" />
          </label>

          <div class="actions">
            <button class="btnPrimary" type="button" data-testid="task-edit-modal-save" @click="saveEdit(editingTask)">保存</button>
            <button class="btnSecondary" type="button" data-testid="task-edit-modal-cancel" @click="stopEdit">取消</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: none;
  border-radius: var(--radius);
  padding: 16px;
  background: var(--surface);
  box-shadow: var(--shadow-md);
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.headerLeft {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.headerRight {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.queueControls {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.queueDot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.9);
  box-shadow: 0 0 0 2px rgba(148, 163, 184, 0.18);
}
.queueDot.on {
  background: rgba(16, 185, 129, 1);
  box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.22);
}
.title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.count {
  background: #e2e8f0;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}
.empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 2px 2px 2px;
  color: #64748b;
  font-size: 13px;
  flex: 1 1 auto;
  min-height: 0;
}
.hint {
  color: #94a3b8;
  font-size: 12px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  background: rgba(248, 250, 252, 0.65);
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  min-height: 0;
  flex: 1 1 auto;
}
.item {
  position: relative;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.92);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.item:hover {
  background: rgba(15, 23, 42, 0.02);
}
.item:last-child {
  border-bottom: none;
}
.item.active {
  background: rgba(37, 99, 235, 0.05);
  box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.20);
}
.item.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 999px;
  background: #2563eb;
}
.row {
  display: flex;
  gap: 10px;
  align-items: stretch;
  background: transparent;
}
.row-main {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 12px;
  cursor: pointer;
  text-align: left;
  min-width: 0;
}
.row-top {
  display: flex;
  align-items: center;
  min-width: 0;
}
.row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.row-title {
  flex: 1;
  min-width: 0;
  font-weight: 700;
  font-size: 14px;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item[data-status="running"] .row-title {
  color: var(--accent);
}
.item[data-status="completed"] .row-title {
  color: #16a34a;
}
.item[data-status="failed"] .row-title {
  color: var(--danger);
}
.item[data-status="cancelled"] .row-title {
  color: var(--muted);
}
.row-sub {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  align-items: center;
  min-width: 0;
}
.tags {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(241, 245, 249, 0.85);
  color: #475569;
  font-size: 11px;
  font-weight: 700;
}
.tag.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.preview {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: rgba(100, 116, 139, 0.95);
}
.row-actions {
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px;
  padding: 8px 8px 8px 0;
  opacity: 0.65;
  transition: opacity 0.15s ease;
}
.item:hover .row-actions,
.item.active .row-actions {
  opacity: 1;
}
.btn {
  padding: 8px 10px;
  border-radius: 8px;
  border: none;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  background: #f1f5f9;
  color: #475569;
}
.btn:hover {
  background: #e2e8f0;
}
.iconBtn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: transparent;
  color: var(--muted);
  transition: color 0.15s ease, opacity 0.15s ease;
}
.iconBtn:hover:not(:disabled) {
  color: var(--text);
}
.iconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.iconBtn.danger {
  color: var(--danger);
}
.iconBtn.danger:hover:not(:disabled) {
  color: var(--danger-2);
}
.iconBtn.primary {
  color: var(--accent);
}
.iconBtn.primary:hover:not(:disabled) {
  color: var(--accent-2);
}
.modalOverlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.42);
  display: grid;
  place-items: center;
  padding: 12px;
  z-index: 9999;
}
.modalCard {
  width: min(900px, 100%);
  max-height: 88vh;
  overflow: hidden;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
}
.modalHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
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
  margin: 0 0 6px 0;
}
.modalBody {
  padding: 24px 26px;
  display: grid;
  gap: 16px;
  background: var(--surface);
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
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.grid {
  display: grid;
  grid-template-columns: minmax(160px, 260px) 96px 120px;
  gap: 10px;
  align-items: end;
  min-width: 0;
}
.field {
  display: block;
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
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #475569;
  white-space: nowrap;
  flex: 0 0 auto;
  margin-bottom: 2px;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 18px;
}
.btnPrimary {
  border-radius: 18px;
  padding: 12px 44px;
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
  border-radius: 18px;
  padding: 12px 40px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid rgba(79, 142, 247, 0.35);
  background: rgba(79, 142, 247, 0.12);
  color: #2563eb;
  transition: border-color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}
.btnSecondary:hover {
  border-color: rgba(79, 142, 247, 0.6);
  background: rgba(79, 142, 247, 0.18);
  transform: translateY(-1px);
}
.btnSecondary:active {
  background: rgba(79, 142, 247, 0.22);
}
.plan {
  border-top: 1px solid #e2e8f0;
  background: #fbfdff;
  padding: 10px 12px;
  max-height: min(40vh, 320px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.plan-empty {
  color: #94a3b8;
  font-size: 12px;
}
.plan-rows {
  display: grid;
  gap: 4px;
}
.plan-row {
  display: grid;
  grid-template-columns: 18px 1fr 14px;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(226, 232, 240, 0.9);
}
.plan-row[data-status="running"] {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.06);
}
.plan-row[data-status="completed"] {
  opacity: 0.85;
}
.plan-step {
  font-variant-numeric: tabular-nums;
  color: #64748b;
  font-weight: 700;
  font-size: 11px;
}
.plan-title {
  color: #0f172a;
  font-size: 11px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-status {
  display: grid;
  place-items: center;
  height: 18px;
}
.ok {
  color: #16a34a;
  font-weight: 900;
  font-size: 14px;
}
.attachmentsRow {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}
.attachmentLink {
  display: inline-block;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 700;
  color: #334155;
  text-decoration: none;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(248, 250, 252, 0.9);
  padding: 2px 6px;
  border-radius: 999px;
}
.attachmentLink:hover {
  background: rgba(226, 232, 240, 0.9);
}
.attachmentsMore {
  height: 16px;
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  color: #475569;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(241, 245, 249, 0.9);
  flex: 0 0 auto;
}
.run {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
  animation: pulse 1.2s infinite;
}
.wait {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #cbd5e1;
}
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.6; }
}
@media (max-width: 600px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .row {
    flex-direction: column;
  }
  .row-actions {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 0 12px 12px 12px;
  }
}
</style>

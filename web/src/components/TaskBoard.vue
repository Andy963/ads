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
  apiToken?: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "togglePlan", id: string): void;
  (e: "ensurePlan", id: string): void;
  (e: "update", payload: { id: string; updates: TaskUpdates }): void;
  (e: "cancel", id: string): void;
  (e: "retry", id: string): void;
  (e: "delete", id: string): void;
  (e: "reorder", ids: string[]): void;
  (e: "runSingle", id: string): void;
  (e: "queueRun"): void;
  (e: "queuePause"): void;
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
    case "queued":
      return "Queued";
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

function withTokenQuery(url: string): string {
  const token = String(props.apiToken ?? "").trim();
  if (!token) return url;
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}token=${encodeURIComponent(token)}`;
}

function attachmentsFor(task: Task): NonNullable<Task["attachments"]> {
  return Array.isArray((task as { attachments?: unknown }).attachments) ? (task.attachments ?? []) : [];
}

const sorted = computed(() => {
  const weight = (s: string) =>
    s === "running"
      ? 0
      : s === "planning"
        ? 1
        : s === "queued"
          ? 2
          : s === "pending"
            ? 3
            : 4;
  return props.tasks
    .slice()
    .sort((a, b) => {
      const wa = weight(a.status);
      const wb = weight(b.status);
      if (wa !== wb) return wa - wb;
      if (a.status !== b.status) return a.status.localeCompare(b.status);
      if ((a.status === "pending" && b.status === "pending") || (a.status === "queued" && b.status === "queued")) {
        if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
        return a.createdAt - b.createdAt;
      }
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.createdAt - a.createdAt;
    });
});

const queuedPositionById = computed(() => {
  const queued = props.tasks
    .filter((t) => t.status === "queued")
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
      return a.createdAt - b.createdAt;
    });
  return new Map(queued.map((t, idx) => [t.id, idx + 1]));
});

function queuedTag(task: Task): string {
  const pos = queuedPositionById.value.get(task.id);
  if (pos) return `Queued #${pos}`;
  return "Queued";
}

const pendingIds = computed(() => sorted.value.filter((t) => t.status === "pending").map((t) => t.id));
const canReorder = computed(() => true);

const dragTaskId = ref<string | null>(null);
const dragOverTaskId = ref<string | null>(null);

const listRef = ref<HTMLElement | null>(null);
const itemRefById = new Map<string, HTMLElement>();

function setItemRef(id: string, el: Element | null): void {
  if (!el) {
    itemRefById.delete(id);
    return;
  }
  if (el instanceof HTMLElement) {
    itemRefById.set(id, el);
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  } catch {
    return true;
  }
}

function scrollExpandedIntoView(taskId: string): void {
  const list = listRef.value;
  const item = itemRefById.get(taskId) ?? null;
  if (!item) return;

  const target =
    (item.querySelector(".plan") as HTMLElement | null) ??
    (item.querySelector(".editor") as HTMLElement | null) ??
    item;
  if (!list) {
    target.scrollIntoView({ block: "nearest" });
    return;
  }

  // Use rects instead of offsetTop to avoid offsetParent pitfalls.
  const listRect = list.getBoundingClientRect();
  const itemRect = target.getBoundingClientRect();
  const pad = 12;

  // Item is above the visible viewport of the list.
  if (itemRect.top < listRect.top + pad) {
    const delta = itemRect.top - listRect.top - pad;
    const nextTop = Math.max(0, list.scrollTop + delta);
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    if (typeof list.scrollTo === "function") list.scrollTo({ top: nextTop, behavior });
    else list.scrollTop = nextTop;
    return;
  }

  // Item is below the visible viewport of the list (ensure the bottom is visible).
  if (itemRect.bottom > listRect.bottom - pad) {
    const delta = itemRect.bottom - listRect.bottom + pad;
    const nextTop = Math.max(0, list.scrollTop + delta);
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    if (typeof list.scrollTo === "function") list.scrollTo({ top: nextTop, behavior });
    else list.scrollTop = nextTop;
  }
}

watch(
  () => props.expanded,
  async (next, prev) => {
    // Only scroll when a task is newly expanded (not when collapsing).
    const prevSet = prev ?? new Set<string>();
    const newlyExpanded = [...next].filter((id) => !prevSet.has(id));
    if (newlyExpanded.length === 0) return;
    await nextTick();
    for (const id of newlyExpanded) scrollExpandedIntoView(id);
  },
);

const lastPlanLengthById = new Map<string, number>();
watch(
  () => props.plans,
  async () => {
    // When the plan content arrives after expansion, keep the expanded plan visible.
    const expandedIds = [...props.expanded];
    if (expandedIds.length === 0) return;

    const changed: string[] = [];
    for (const id of expandedIds) {
      const len = props.plans.get(id)?.length ?? 0;
      const prevLen = lastPlanLengthById.get(id) ?? 0;
      if (len !== prevLen) {
        changed.push(id);
        lastPlanLengthById.set(id, len);
      }
    }
    if (changed.length === 0) return;

    await nextTick();
    for (const id of changed) scrollExpandedIntoView(id);
  },
  { deep: false },
);

function canDrag(task: Task): boolean {
  if (!canReorder.value) return false;
  if (task.status !== "pending") return false;
  if (editingId.value === task.id) return false;
  return true;
}

function onDragStart(task: Task, ev: DragEvent): void {
  if (!canDrag(task)) return;
  dragTaskId.value = task.id;
  dragOverTaskId.value = null;
  try {
    ev.dataTransfer?.setData("application/x-ads-task-id", task.id);
    ev.dataTransfer?.setData("text/plain", task.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  } catch {
    // ignore
  }
}

function onDragOver(task: Task, ev: DragEvent): void {
  if (!canReorder.value) return;
  if (task.status !== "pending") return;
  const from = dragTaskId.value;
  if (!from || from === task.id) return;
  ev.preventDefault();
  try {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  } catch {
    // ignore
  }
  dragOverTaskId.value = task.id;
}

function onDrop(task: Task, ev: DragEvent): void {
  if (!canReorder.value) return;
  if (task.status !== "pending") return;
  ev.preventDefault();
  const from =
    dragTaskId.value ||
    ev.dataTransfer?.getData("application/x-ads-task-id") ||
    ev.dataTransfer?.getData("text/plain");
  const draggedId = String(from ?? "").trim();
  if (!draggedId) return;
  if (draggedId === task.id) return;

  const ids = pendingIds.value.slice();
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(task.id);
  if (fromIdx < 0 || toIdx < 0) return;

  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, draggedId);
  emit("reorder", ids);

  dragTaskId.value = null;
  dragOverTaskId.value = null;
}

function onDragEnd(): void {
  dragTaskId.value = null;
  dragOverTaskId.value = null;
}

const editingId = ref<string | null>(null);
const editTitle = ref("");
const editPrompt = ref("");
const editModel = ref("auto");
const editPriority = ref(0);
const editMaxRetries = ref(3);
const editInheritContext = ref(false);
const error = ref<string | null>(null);
const editPromptEl = ref<HTMLTextAreaElement | null>(null);

const editingTask = computed(() => {
  const id = String(editingId.value ?? "").trim();
  if (!id) return null;
  return props.tasks.find((t) => t.id === id) ?? null;
});

function startEdit(task: Task): void {
  editingId.value = task.id;
  editTitle.value = task.title ?? "";
  editPrompt.value = task.prompt ?? "";
  editModel.value = task.model ?? "auto";
  editPriority.value = task.priority ?? 0;
  editMaxRetries.value = task.maxRetries ?? 3;
  editInheritContext.value = Boolean(task.inheritContext);
  error.value = null;
}

function stopEdit(): void {
  editingId.value = null;
  error.value = null;
}

function saveEdit(task: Task): void {
  const title = editTitle.value.trim();
  const prompt = editPrompt.value.trim();
  if (!title) {
    error.value = "Title is required";
    return;
  }
  if (!prompt) {
    error.value = "Prompt is required";
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

watch(editingId, async (id) => {
  if (!id) return;
  await nextTick();
  editPromptEl.value?.focus?.();
});

watch(
  () => editingTask.value,
  (task) => {
    if (!editingId.value) return;
    if (!task) stopEdit();
  },
);

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

function isRunBusy(taskId: string): boolean {
  return props.runBusyIds?.has(taskId) ?? false;
}

function canRunSingleTask(task: Task): boolean {
  if (props.canRunSingle === false) return false;
  if (props.queueStatus) {
    if (!props.queueStatus.enabled || !props.queueStatus.ready) return false;
    if (props.queueStatus.running) return false;
  }
  if (task.status === "planning" || task.status === "running") return false;
  if (editingId.value === task.id) return false;
  return task.status === "pending" || task.status === "queued" || task.status === "paused";
}

function runTitle(task: Task): string {
  if (props.canRunSingle === false) return "Unauthorized";
  if (props.queueStatus) {
    if (!props.queueStatus.enabled) return "Task queue disabled";
    if (!props.queueStatus.ready) return "Agent not ready";
    if (props.queueStatus.running) return "Task queue is running";
  }
  if (editingId.value === task.id) return "Editing";
  if (task.status === "planning" || task.status === "running") return "Task is running";
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return "Task not runnable";
  if (task.status === "pending" || task.status === "queued" || task.status === "paused") return "Run task";
  return "Run task";
}
</script>

<template>
  <div class="card">
    <div class="header">
      <h3 class="title">任务列表</h3>
      <div class="headerRight">
        <button
          v-if="queueStatus?.enabled"
          class="queueBtn"
          type="button"
          :disabled="!queueStatus?.ready"
          @click="queueStatus?.running ? emit('queuePause') : emit('queueRun')"
        >
          {{ queueStatus?.running ? "Pause" : "Run" }}
        </button>
        <span class="count">{{ tasks.length }}</span>
      </div>
    </div>

    <div v-if="tasks.length === 0" class="empty">
      <span>暂无任务</span>
      <span class="hint">下面输入 Prompt 回车创建任务</span>
    </div>

    <div v-else ref="listRef" class="list">
        <div
          v-for="t in sorted"
          :key="t.id"
          class="item"
          :data-status="t.status"
          :class="{ active: t.id === selectedId, dragOver: dragOverTaskId === t.id, expanded: expanded.has(t.id) }"
          :ref="(el) => setItemRef(t.id, el)"
          @dragover="onDragOver(t, $event)"
          @drop="onDrop(t, $event)"
        >
        <div class="row">
          <div
            v-if="t.status === 'pending'"
            class="dragHandle"
            :class="{ disabled: !canDrag(t) }"
            :draggable="canDrag(t)"
            title="Drag to reorder"
            @dragstart="onDragStart(t, $event)"
            @dragend="onDragEnd"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M7 4a1 1 0 1 1 0 2a1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2a1 1 0 0 1 0-2ZM7 9a1 1 0 1 1 0 2a1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2a1 1 0 0 1 0-2ZM7 14a1 1 0 1 1 0 2a1 1 0 0 1 0-2Zm6 0a1 1 0 1 1 0 2a1 1 0 0 1 0-2Z" />
            </svg>
          </div>
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
                <span v-if="t.status === 'queued'" class="tag">{{ queuedTag(t) }}</span>
              </div>
              <span v-if="t.prompt && t.prompt.trim()" class="preview" :title="t.prompt">
                {{ formatPromptPreview(t.prompt) }}
              </span>
            </div>
            <div v-if="attachmentsFor(t).length" class="attachmentsRow">
              <span class="attachmentsMore">Images x{{ attachmentsFor(t).length }}</span>
            </div>
          </button>
          <div class="row-actions">
            <button
              class="iconBtn primary runBtn"
              type="button"
              :title="runTitle(t)"
              :disabled="!canRunSingleTask(t) || isRunBusy(t.id)"
              @click.stop="emit('runSingle', t.id)"
            >
              <svg v-if="isRunBusy(t.id)" class="spinner" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="2" opacity="0.25" />
                <path d="M17 10a7 7 0 0 0-7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M7.5 4.75a1 1 0 0 0-1.5.87v8.76a1 1 0 0 0 1.5.87l7.5-4.38a1 1 0 0 0 0-1.74l-7.5-4.38Z" />
              </svg>
            </button>
            <button v-if="t.status === 'pending' && editingId !== t.id" class="iconBtn" type="button" title="编辑" data-testid="task-edit" @click.stop="startEdit(t)">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M13.59 2.59a2 2 0 0 1 2.82 2.82l-8.7 8.7a2 2 0 0 1-.88.5l-3.15.9a1 1 0 0 1-1.24-1.24l.9-3.15a2 2 0 0 1 .5-.88l8.7-8.7Zm1.41 1.41a.5.5 0 0 0-.7 0l-1.3 1.3 1.7 1.7 1.3-1.3a.5.5 0 0 0 0-.7L15 4Zm-2.36 2.36-7.68 7.68-.5 1.76 1.76-.5 7.68-7.68-1.26-1.26Z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <button v-if="t.status === 'pending' && editingId === t.id" class="iconBtn" type="button" title="取消编辑" data-testid="task-edit-cancel" @click.stop="stopEdit()">
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

    <div
      v-if="editingTask && editingTask.status === 'pending'"
      class="modalOverlay"
      role="dialog"
      aria-modal="true"
      data-testid="task-edit-modal"
      @click.self="stopEdit"
    >
      <div class="modalCard">
        <div class="modalTitle">Edit task</div>
        <div v-if="error" class="err">{{ error }}</div>

        <label class="field">
          <span class="label">Title</span>
          <input v-model="editTitle" />
        </label>

        <div class="grid">
          <label class="field">
            <span class="label">Model</span>
            <select v-model="editModel">
              <option v-for="m in modelOptions" :key="m.id" :value="m.id">
                {{ m.displayName }}{{ m.provider ? ` (${m.provider})` : "" }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="label">Priority</span>
            <input v-model.number="editPriority" type="number" />
          </label>
          <label class="field">
            <span class="label">Max retries</span>
            <input v-model.number="editMaxRetries" type="number" min="0" />
          </label>
        </div>

        <label class="check">
          <input v-model="editInheritContext" type="checkbox" />
          <span>Inherit context</span>
        </label>

        <label class="field">
          <span class="label">Prompt</span>
          <textarea ref="editPromptEl" v-model="editPrompt" class="modalTextarea" rows="14" data-testid="task-edit-prompt" />
        </label>

        <div class="modalActions">
          <button class="modalBtn" type="button" data-testid="task-edit-modal-cancel" @click="stopEdit">Cancel</button>
          <button class="modalBtn primary" type="button" data-testid="task-edit-modal-save" @click="saveEdit(editingTask)">Save</button>
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
.headerRight {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.queueBtn {
  height: 28px;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: white;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  color: #0f172a;
}
.queueBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.runBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.spinner {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
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
  z-index: 0;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.92);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.item.expanded {
  z-index: 2;
  overflow: visible;
}
.item.dragOver {
  z-index: 3;
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
.item.dragOver {
  background: rgba(37, 99, 235, 0.08);
}
.row {
  display: flex;
  gap: 10px;
  align-items: stretch;
  background: transparent;
}
.dragHandle {
  width: 30px;
  display: grid;
  place-items: center;
  color: rgba(100, 116, 139, 0.95);
  user-select: none;
  cursor: grab;
}
.dragHandle.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.dragHandle:active:not(.disabled) {
  cursor: grabbing;
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
.item[data-status="queued"] .row-title {
  color: #d97706;
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
.attachmentsRow {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  gap: 6px;
  margin-top: 6px;
  padding-left: 2px;
  overflow: hidden;
  flex-wrap: wrap;
  min-height: 16px;
  row-gap: 4px;
}
.attachmentLink {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 700;
  color: rgba(30, 41, 59, 0.85);
  text-decoration: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  background: rgba(248, 250, 252, 0.85);
}
.attachmentLink:hover {
  border-color: rgba(37, 99, 235, 0.55);
  color: rgba(15, 23, 42, 0.95);
}
.attachmentsMore {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  height: 16px;
  font-size: 10px;
  font-weight: 800;
  color: rgba(15, 23, 42, 0.65);
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(226, 232, 240, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.35);
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
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.55);
}
.modalCard {
  width: min(820px, 100%);
  max-height: min(92vh, 900px);
  overflow: auto;
  border-radius: 16px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
  padding: 16px;
  display: grid;
  gap: 10px;
}
.modalTitle {
  font-size: 14px;
  font-weight: 900;
  color: #0f172a;
  letter-spacing: 0.02em;
}
.editor {
  border-top: 1px solid #e2e8f0;
  background: #f8fafc;
  padding: 12px;
  display: grid;
  gap: 10px;
}
.err {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  color: #dc2626;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.field {
  display: block;
}
.label {
  display: block;
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  margin-bottom: 6px;
}
input,
select,
textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  font-size: 14px;
  background: white;
  color: #1e293b;
  box-sizing: border-box;
}
textarea {
  resize: none;
  max-height: 200px;
  overflow-y: auto;
}
.modalTextarea {
  resize: vertical;
  max-height: 60vh;
  min-height: 240px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #475569;
}
.actions,
.modalActions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.modalBtn {
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid rgba(148, 163, 184, 0.55);
  background: white;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  color: #0f172a;
}
.modalBtn:hover {
  border-color: rgba(37, 99, 235, 0.55);
}
.modalBtn.primary {
  border-color: rgba(37, 99, 235, 0.65);
  background: rgba(37, 99, 235, 0.08);
}
.modalBtn.primary:hover {
  background: rgba(37, 99, 235, 0.12);
}
.plan {
  border-top: 1px solid #e2e8f0;
  background: #fbfdff;
  padding: 10px 12px;
  max-height: min(40vh, 320px);
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
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
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  word-break: break-word;
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

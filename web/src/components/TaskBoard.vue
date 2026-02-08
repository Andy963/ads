<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { ChatDotRound, Delete, Edit, Plus, Refresh } from "@element-plus/icons-vue";
import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";
import DraggableModal from "./DraggableModal.vue";

type TaskUpdates = Partial<Pick<Task, "title" | "prompt" | "model" | "priority" | "inheritContext" | "maxRetries">>;

const TASK_CARD_PALETTE = [
  "#dbeafe",
  "#e0e7ff",
  "#ede9fe",
  "#fae8ff",
  "#fce7f3",
  "#ffe4e6",
  "#ffedd5",
  "#fef3c7",
  "#ecfccb",
  "#dcfce7",
  "#d1fae5",
  "#cffafe",
  "#e0f2fe",
  "#f1f5f9",
];

const props = defineProps<{
  tasks: Task[];
  models: ModelConfig[];
  selectedId?: string | null;
  queueStatus?: TaskQueueStatus | null;
  canRunSingle?: boolean;
  runBusyIds?: Set<string>;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "create"): void;
  (e: "newSession"): void;
  (e: "resumeThread"): void;
  (e: "update", payload: { id: string; updates: TaskUpdates }): void;
  (e: "update-and-run", payload: { id: string; updates: TaskUpdates }): void;
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

function hashStringFNV1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeHex(hex: string): string | null {
  const raw = String(hex ?? "").trim().replace(/^#/, "");
  if (!raw) return null;
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    const expanded = raw
      .split("")
      .map((c) => `${c}${c}`)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }
  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const v = normalized.slice(1);
  const r = Number.parseInt(v.slice(0, 2), 16);
  const g = Number.parseInt(v.slice(2, 4), 16);
  const b = Number.parseInt(v.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

function toHexChannel(v: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(v)));
  return clamped.toString(16).padStart(2, "0");
}

function mixHex(a: string, b: string, t: number): string {
  const aa = hexToRgb(a);
  const bb = hexToRgb(b);
  const ratio = Math.max(0, Math.min(1, t));
  if (!aa || !bb) return a;
  const r = aa.r + (bb.r - aa.r) * ratio;
  const g = aa.g + (bb.g - aa.g) * ratio;
  const b2 = aa.b + (bb.b - aa.b) * ratio;
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(b2)}`;
}

function srgbToLinear(v: number): number {
  const s = v / 255;
  if (s <= 0.04045) return s / 12.92;
  return ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pickInk(bgHex: string): { ink: string; inkMuted: string } {
  const rgb = hexToRgb(bgHex);
  if (!rgb) return { ink: "#0f172a", inkMuted: "#334155" };
  const lum = relativeLuminance(rgb);
  if (lum < 0.46) return { ink: "#f8fafc", inkMuted: "rgba(248, 250, 252, 0.85)" };
  return { ink: "#0f172a", inkMuted: "#334155" };
}

function taskColorVars(task: Task): Record<string, string> {
  const id = String(task.id ?? "").trim();
  const bg = TASK_CARD_PALETTE[hashStringFNV1a(id || JSON.stringify(task)) % TASK_CARD_PALETTE.length];
  const border = mixHex(bg, "#0f172a", 0.16);
  const { ink, inkMuted } = pickInk(bg);
  return {
    "--task-bg": bg,
    "--task-border": border,
    "--task-ink": ink,
    "--task-ink-muted": inkMuted,
  };
}

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
  const weight = (s: string) => {
    if (s === "running") return 0;
    if (s === "planning") return 1;
    if (s === "pending" || s === "queued") return 2;
    if (s === "completed") return 9;
    return 5;
  };
  return props.tasks
    .filter((t) => t.archivedAt == null)
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
  saveEditWithEvent(task, "update");
}

function saveEditAndRun(task: Task): void {
  saveEditWithEvent(task, "update-and-run");
}

function saveEditWithEvent(task: Task, event: "update" | "update-and-run"): void {
  const title = editTitle.value.trim();
  const prompt = editPrompt.value.trim();
  if (!title) {
    error.value = "标题不能为空";
    return;
  }
  if (!prompt) {
    error.value = "任务描述不能为空";
    return;
  }

  emit(event, {
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

const queueStatus = computed(() => props.queueStatus ?? null);
const queueCanRunAll = computed(() => Boolean(queueStatus.value?.enabled) && Boolean(queueStatus.value?.ready));
const queueIsRunning = computed(() => Boolean(queueStatus.value?.running));
const canResumeThread = computed(() => {
  if (queueIsRunning.value) return false;
  return !props.tasks.some((t) => t.status === "planning" || t.status === "running");
});
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
  return status === "pending" || status === "queued" || status === "paused" || status === "cancelled";
}

function canRerunTask(task: Task): boolean {
  const status = task.status;
  return status === "completed" || status === "failed";
}

function canEditTask(task: Task): boolean {
  if (canRerunTask(task)) return true;
  return task.status === "pending" || task.status === "queued" || task.status === "cancelled";
}

const editPrimaryLabel = computed(() => {
  const task = editingTask.value;
  if (!task) return "保存并提交";
  return canRerunTask(task) ? "重新执行" : "保存并提交";
});

const showEditSaveButton = computed(() => {
  const task = editingTask.value;
  if (!task) return true;
  return !canRerunTask(task);
});

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
        <button class="iconBtn" type="button" title="恢复上下文" aria-label="恢复上下文" :disabled="!canResumeThread"
          @click.stop="emit('resumeThread')">
          <el-icon :size="16" aria-hidden="true" class="icon">
            <Refresh />
          </el-icon>
        </button>
        <button class="iconBtn" type="button" title="新会话" aria-label="新会话" @click.stop="emit('newSession')">
          <el-icon :size="16" aria-hidden="true" class="icon">
            <ChatDotRound />
          </el-icon>
        </button>
      </div>
    </div>

    <div v-if="tasks.length === 0" class="empty">
      <span>暂无任务</span>
      <span class="hint">点击 + 新建任务</span>
    </div>

    <div v-else class="list">
      <div class="mindmap">
        <div v-for="t in sorted" :key="t.id" class="item" :data-status="t.status" :data-task-id="t.id"
          :class="{ active: t.id === selectedId }" :style="taskColorVars(t)">
          <div class="row">
            <button class="row-main" type="button" @click="emit('select', t.id)">
              <div class="row-top">
                <div class="row-head">
                  <span class="row-title" :title="statusLabel(t.status)">{{ t.title || "(未命名任务)" }}</span>
                </div>
              </div>
            </button>
            <div class="row-actions">
              <button v-if="canRunSingleTask(t)" class="iconBtn primary" type="button"
                :disabled="!canRunSingleNow || isRunBusy(t.id)" :title="queueIsRunning ? '请先暂停队列，再单独运行' : '单独运行该任务'"
                aria-label="单独运行任务" @click.stop="emit('runSingle', t.id)">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M7 4.5v11l9-5.5-9-5.5Z" />
                </svg>
              </button>
              <button v-if="canRerunTask(t) && editingId !== t.id" class="iconBtn primary" type="button" title="重新执行"
                :disabled="Boolean(editingId)" @click.stop="startEdit(t)">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd"
                    d="M10 3a7 7 0 1 0 7 7 .75.75 0 0 0-1.5 0 5.5 5.5 0 1 1-1.38-3.65l-1.62 1.6a.75.75 0 0 0 .53 1.28H17a.75.75 0 0 0 .75-.75V3.5a.75.75 0 0 0-1.28-.53l-1.13 1.12A6.98 6.98 0 0 0 10 3Z"
                    clip-rule="evenodd" />
                </svg>
              </button>
              <button v-if="canEditTask(t) && !canRerunTask(t) && editingId !== t.id" class="iconBtn" type="button"
                title="编辑" :disabled="Boolean(editingId)" data-testid="task-edit" @click.stop="startEdit(t)">
                <el-icon :size="16" aria-hidden="true" class="icon">
                  <Edit />
                </el-icon>

              </button>
              <button v-if="editingId === t.id" class="iconBtn" type="button" title="取消编辑" @click.stop="stopEdit()">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd"
                    d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                    clip-rule="evenodd" />
                </svg>
              </button>
              <button v-if="t.status === 'running' || t.status === 'planning'" class="iconBtn danger" type="button"
                title="终止任务" @click.stop="emit('cancel', t.id)">
                <span class="interruptSpinner" aria-hidden="true" />
              </button>
              <button v-if="t.status === 'failed'" class="iconBtn" type="button" title="重试"
                @click.stop="emit('retry', t.id)">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd"
                    d="M10 4a6 6 0 0 0-5.2 9h2.1a1 1 0 0 1 .8 1.6l-2.4 3.2a1 1 0 0 1-1.6 0l-2.4-3.2A1 1 0 0 1 2.1 13h1.2A8 8 0 1 1 10 18a.75.75 0 0 1 0-1.5A6.5 6.5 0 1 0 3.62 10a.75.75 0 1 1-1.5 0A8 8 0 0 1 10 2a.75.75 0 0 1 0 1.5Z"
                    clip-rule="evenodd" />
                </svg>
              </button>
              <button class="iconBtn danger" type="button" title="删除任务"
                :disabled="t.status === 'running' || t.status === 'planning'" @click.stop="emit('delete', t.id)">
                <el-icon :size="16" aria-hidden="true" class="icon">
                  <Delete />
                </el-icon>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <DraggableModal v-if="editingTask" card-variant="large" data-testid="task-edit-modal" @close="stopEdit">
      <div class="modalHeader">
        <div class="modalTitle" data-drag-handle>编辑任务</div>
        <button class="iconBtn" type="button" aria-label="关闭" title="关闭" data-testid="task-edit-modal-cancel"
          @click="stopEdit">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd"
              d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
              clip-rule="evenodd" />
          </svg>
        </button>
      </div>

      <div class="modalBody">
        <div class="modalTitle main" data-drag-handle>编辑任务</div>
        <div v-if="error" class="err">{{ error }}</div>

        <label class="field">
          <span class="label">标题</span>
          <input ref="editTitleEl" v-model="editTitle" />
        </label>

        <div class="configRow">
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
          <label class="field">
            <span class="label">继承上下文</span>
            <select v-model="editInheritContext">
              <option :value="true">True</option>
              <option :value="false">False</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span class="label">任务描述</span>
          <textarea v-model="editPrompt" rows="6" data-testid="task-edit-prompt" />
        </label>

        <div class="actions">
          <button class="btnSecondary" type="button" data-testid="task-edit-modal-cancel" @click="stopEdit">取消</button>
          <button v-if="showEditSaveButton" class="btnSecondary" type="button" :disabled="!editingTask"
            data-testid="task-edit-modal-save" @click="saveEdit(editingTask)">
            保存
          </button>
          <button class="btnPrimary" type="button" :disabled="!editingTask" data-testid="task-edit-modal-save-and-run"
            @click="editingTask && saveEditAndRun(editingTask)">
            {{ editPrimaryLabel }}
          </button>
        </div>
      </div>
    </DraggableModal>
  </div>
</template>
<style src="./TaskBoard.css" scoped></style>

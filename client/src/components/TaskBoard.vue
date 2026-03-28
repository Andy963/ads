<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Delete, Edit, Plus } from "@element-plus/icons-vue";
import type { ReviewSnapshot, Task, TaskQueueStatus } from "../api/types";
import type { ApiClient } from "../api/client";
import TaskBoardDetailModal from "./TaskBoardDetailModal.vue";
import TaskBoardReviewSnapshotModal from "./TaskBoardReviewSnapshotModal.vue";
import TaskBoardEditModal from "./TaskBoardEditModal.vue";
import { deriveTaskStage, type TaskStage } from "../lib/task_stage";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

type BootstrapConfig = {
  enabled: true;
  projectRef: string;
  maxIterations?: number;
};

type TaskUpdates = Partial<Pick<Task, "title" | "prompt" | "agentId" | "priority" | "maxRetries" | "reviewRequired">> & {
  bootstrap?: BootstrapConfig | null;
};

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

const normalizedActiveAgentId = computed(() => String(props.activeAgentId ?? "").trim());

function formatAgentLabel(agent: AgentOption): string {
  const id = String(agent.id ?? "").trim();
  const name = String(agent.name ?? "").trim() || id;
  if (!id) return name || "agent";
  const base = name === id ? id : `${name} (${id})`;
  if (agent.ready) return base;
  const suffix = String(agent.error ?? "").trim() || "不可用";
  return `${base}（不可用：${suffix}）`;
}

function pickDefaultAgentId(preferred?: string | null): string {
  const options = readyAgentOptions.value;
  const preferredId = String(preferred ?? "").trim();
  if (preferredId) {
    if (options.some((a) => a.id === preferredId)) {
      return preferredId;
    }
    return "";
  }

  const active = normalizedActiveAgentId.value;
  if (active && options.some((a) => a.id === active)) {
    return active;
  }

  return options[0]?.id ?? "";
}

type BootstrapTaskConfig = { projectRef: string; maxIterations: number };

function clampBootstrapIterations(raw: unknown): number {
  const parsed = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 10;
  return Math.max(1, Math.min(10, parsed));
}

function readBootstrapConfig(task: Task): BootstrapTaskConfig | null {
  const params = task.modelParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const bootstrap = (params as { bootstrap?: unknown }).bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    return null;
  }
  const enabled = (bootstrap as { enabled?: unknown }).enabled;
  if (enabled !== true) {
    return null;
  }
  const projectRef = String((bootstrap as { projectRef?: unknown }).projectRef ?? "").trim();
  if (!projectRef) {
    return null;
  }
  const maxIterations = clampBootstrapIterations((bootstrap as { maxIterations?: unknown }).maxIterations);
  return { projectRef, maxIterations };
}


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

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "pending":
      return "待启动";
    case "planning":
      return "规划中";
    case "running":
      return "执行中";
    case "paused":
      return "已暂停";
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

function reviewBadge(task: Task): { label: string; status: Task["reviewStatus"]; title?: string } | null {
  if (!task.reviewRequired) return null;
  const status = task.reviewStatus ?? "none";
  const conclusion = String(task.reviewConclusion ?? "").trim() || undefined;
  switch (status) {
    case "running":
      return { label: "审核中", status };
    case "passed":
      return { label: "通过", status, title: conclusion };
    case "rejected":
      return { label: "驳回", status, title: conclusion };
    case "failed":
      return { label: "失败", status, title: conclusion };
    case "pending":
      return { label: "待审", status };
    case "none":
    default:
      return { label: "待审", status: status === "none" ? "pending" : status };
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

function deriveTaskTitleFromPrompt(prompt: string): string {
  const firstLine = String(prompt ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const base = (firstLine ?? "新任务").replace(/\s+/g, " ");
  const maxLen = 32;
  if (base.length <= maxLen) return base;
  return `${base.slice(0, maxLen)}…`;
}

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

function stageTitle(stage: TaskStage): string {
  switch (stage) {
    case "backlog":
      return "待办";
    case "in_progress":
      return "进行中";
    case "in_review":
      return "审核中";
    case "done":
      return "已完成";
  }
}

function backlogStatusWeight(status: Task["status"]): number {
  switch (status) {
    case "pending":
      return 0;
    case "queued":
      return 1;
    case "paused":
      return 2;
    case "cancelled":
      return 3;
    default:
      return 9;
  }
}

function inProgressStatusWeight(status: Task["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "planning":
      return 1;
    case "failed":
      return 2;
    default:
      return 9;
  }
}

function inReviewStatusWeight(status: Task["reviewStatus"]): number {
  switch (status) {
    case "running":
      return 0;
    case "pending":
      return 1;
    case "rejected":
      return 2;
    case "none":
      return 3;
    case "passed":
      return 9;
    default:
      return 9;
  }
}

function finiteOrInfinity(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Number.POSITIVE_INFINITY;
}

function finiteOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function compareBacklogTasks(a: Task, b: Task): number {
  const wa = backlogStatusWeight(a.status);
  const wb = backlogStatusWeight(b.status);
  if (wa !== wb) return wa - wb;
  if (a.priority !== b.priority) return b.priority - a.priority;

  if (a.status === "pending" && b.status === "pending") {
    const aq = finiteOrInfinity(a.queueOrder);
    const bq = finiteOrInfinity(b.queueOrder);
    if (aq !== bq) return aq - bq;
    const ac = finiteOrInfinity(a.createdAt);
    const bc = finiteOrInfinity(b.createdAt);
    if (ac !== bc) return ac - bc;
    return a.id.localeCompare(b.id);
  }

  const aq = finiteOrInfinity(a.queueOrder);
  const bq = finiteOrInfinity(b.queueOrder);
  if (aq !== bq) return aq - bq;

  const ac = finiteOrInfinity(a.createdAt);
  const bc = finiteOrInfinity(b.createdAt);
  if (ac !== bc) return bc - ac;
  return a.id.localeCompare(b.id);
}

function compareInProgressTasks(a: Task, b: Task): number {
  const wa = inProgressStatusWeight(a.status);
  const wb = inProgressStatusWeight(b.status);
  if (wa !== wb) return wa - wb;

  const ar = finiteOrZero(a.startedAt);
  const br = finiteOrZero(b.startedAt);
  if (ar !== br) return br - ar;

  const ac = finiteOrZero(a.completedAt);
  const bc = finiteOrZero(b.completedAt);
  if (ac !== bc) return bc - ac;

  const createdA = finiteOrZero(a.createdAt);
  const createdB = finiteOrZero(b.createdAt);
  if (createdA !== createdB) return createdB - createdA;
  return a.id.localeCompare(b.id);
}

function compareInReviewTasks(a: Task, b: Task): number {
  const wa = inReviewStatusWeight(a.reviewStatus);
  const wb = inReviewStatusWeight(b.reviewStatus);
  if (wa !== wb) return wa - wb;

  const reviewedA = finiteOrZero(a.reviewedAt);
  const reviewedB = finiteOrZero(b.reviewedAt);
  if (reviewedA !== reviewedB) return reviewedB - reviewedA;

  const completedA = finiteOrZero(a.completedAt);
  const completedB = finiteOrZero(b.completedAt);
  if (completedA !== completedB) return completedB - completedA;

  return a.id.localeCompare(b.id);
}

function compareDoneTasks(a: Task, b: Task): number {
  const completedA = finiteOrZero(a.completedAt);
  const completedB = finiteOrZero(b.completedAt);
  if (completedA !== completedB) return completedB - completedA;
  const createdA = finiteOrZero(a.createdAt);
  const createdB = finiteOrZero(b.createdAt);
  if (createdA !== createdB) return createdB - createdA;
  return a.id.localeCompare(b.id);
}

const stageBuckets = computed(() => {
  const buckets: Record<TaskStage, Task[]> = {
    backlog: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const task of props.tasks) {
    buckets[deriveTaskStage(task)].push(task);
  }

  buckets.backlog.sort(compareBacklogTasks);
  buckets.in_progress.sort(compareInProgressTasks);
  buckets.in_review.sort(compareInReviewTasks);
  buckets.done.sort(compareDoneTasks);
  return buckets;
});

type TaskStageSection = {
  stage: TaskStage;
  title: string;
  tasks: Task[];
  testId: string;
};

const stageSections = computed((): TaskStageSection[] => {
  const buckets = stageBuckets.value;
  const stages: TaskStage[] = ["backlog", "in_progress", "in_review", "done"];
  return stages.map((stage) => ({
    stage,
    title: stageTitle(stage),
    tasks: buckets[stage],
    testId: `task-stage-${stage}`,
  }));
});

const totalVisibleTasks = computed(() => stageSections.value.reduce((sum, section) => sum + section.tasks.length, 0));

function defaultStageCollapsed(): Record<TaskStage, boolean> {
  return {
    backlog: true,
    in_progress: true,
    in_review: true,
    done: true,
  };
}

const stageCollapsed = ref<Record<TaskStage, boolean>>(defaultStageCollapsed());

watch(
  () => String(props.workspaceRoot ?? "").trim(),
  (next, prev) => {
    if (next === prev) return;
    stageCollapsed.value = defaultStageCollapsed();
  },
);

function toggleStageCollapse(stage: TaskStage): void {
  stageCollapsed.value[stage] = !stageCollapsed.value[stage];
}

const detailId = ref<string | null>(null);
const detailTask = computed(() => {
  const id = String(detailId.value ?? "").trim();
  if (!id) return null;
  return props.tasks.find((t) => t.id === id) ?? null;
});

const detailTaskStage = computed(() => {
  const task = detailTask.value;
  if (!task) return null;
  return deriveTaskStage(task);
});

const showTaskPromptInDetail = computed(() => {
  return detailTaskStage.value !== "in_review";
});

const workspaceReady = computed(() => Boolean(String(props.workspaceRoot ?? "").trim()));

const withWorkspaceQuery = (apiPath: string): string => {
  const root = String(props.workspaceRoot ?? "").trim();
  if (!root) return apiPath;
  const joiner = apiPath.includes("?") ? "&" : "?";
  return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
};

function closeDetail(): void {
  detailId.value = null;
  closeReviewSnapshot();
}

const reviewSnapshotOpen = ref(false);
const reviewSnapshot = ref<ReviewSnapshot | null>(null);
const reviewSnapshotBusy = ref(false);
const reviewSnapshotError = ref<string | null>(null);

const canViewReviewNotes = computed(() => {
  const task = detailTask.value;
  if (!task || !task.reviewRequired) return false;
  const sid = String(task.reviewSnapshotId ?? "").trim();
  if (!sid) return false;
  return Boolean(props.api) && workspaceReady.value;
});

async function openReviewSnapshot(): Promise<void> {
  reviewSnapshotOpen.value = true;
  reviewSnapshot.value = null;
  reviewSnapshotBusy.value = false;
  reviewSnapshotError.value = null;

  const task = detailTask.value;
  const sid = String(task?.reviewSnapshotId ?? "").trim();
  if (!sid) {
    reviewSnapshotError.value = "No snapshot available";
    return;
  }
  if (!props.api) {
    reviewSnapshotError.value = "API client not available";
    return;
  }
  if (!workspaceReady.value) {
    reviewSnapshotError.value = "Workspace not selected";
    return;
  }

  reviewSnapshotBusy.value = true;
  try {
    const snapshotId = encodeURIComponent(sid);
    reviewSnapshot.value = await props.api.get<ReviewSnapshot>(withWorkspaceQuery(`/api/review-snapshots/${snapshotId}`));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    reviewSnapshotError.value = msg;
  } finally {
    reviewSnapshotBusy.value = false;
  }
}

function closeReviewSnapshot(): void {
  reviewSnapshotOpen.value = false;
  reviewSnapshot.value = null;
  reviewSnapshotBusy.value = false;
  reviewSnapshotError.value = null;
}

function formatTs(ts: number | null | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

const canMarkReviewDone = computed(() => {
  const task = detailTask.value;
  if (!task || !task.reviewRequired) return false;
  if (task.status !== "completed") return false;
  return task.reviewStatus !== "passed";
});

const editingId = ref<string | null>(null);
const editTitle = ref("");
const editPrompt = ref("");
const editAgentId = ref("");
const editPriority = ref(0);
const editMaxRetries = ref(3);
const editReviewRequired = ref(false);
const editBootstrapEnabled = ref(false);
const editBootstrapProject = ref("");
const editBootstrapMaxIterations = ref(10);
const error = ref<string | null>(null);

const editAgentOptions = computed(() => {
  return readyAgentOptions.value.map((agent) => ({
    id: agent.id,
    label: formatAgentLabel(agent),
  }));
});

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
  editAgentId.value = pickDefaultAgentId(task.agentId);
  editPriority.value = task.priority ?? 0;
  editMaxRetries.value = task.maxRetries ?? 3;
  editReviewRequired.value = Boolean(task.reviewRequired);
  const bootstrap = readBootstrapConfig(task);
  editBootstrapEnabled.value = Boolean(bootstrap);
  editBootstrapProject.value = bootstrap?.projectRef ?? "";
  editBootstrapMaxIterations.value = bootstrap?.maxIterations ?? 10;
  error.value = null;
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
  const prompt = editPrompt.value.trim();
  if (!prompt) {
    error.value = "任务描述不能为空";
    return;
  }
  const title = editTitle.value.trim() || deriveTaskTitleFromPrompt(prompt);
  if (!editTitle.value.trim()) {
    editTitle.value = title;
  }
  const projectRef = editBootstrapProject.value.trim();
  if (editBootstrapEnabled.value && !projectRef) {
    error.value = "项目路径不能为空";
    return;
  }
  const maxIterations = clampBootstrapIterations(editBootstrapMaxIterations.value);
  const priorBootstrap = readBootstrapConfig(task);

  emit(event, {
    id: task.id,
    updates: {
      title,
      prompt,
      agentId: editAgentId.value.trim() ? editAgentId.value.trim() : null,
      priority: Number.isFinite(editPriority.value) ? editPriority.value : 0,
      maxRetries: Number.isFinite(editMaxRetries.value) ? editMaxRetries.value : 3,
      reviewRequired: editReviewRequired.value,
      ...(editBootstrapEnabled.value
        ? { bootstrap: { enabled: true, projectRef, maxIterations } }
        : priorBootstrap
          ? { bootstrap: null }
          : {}),
    },
  });
  stopEdit();
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

const pendingBacklogIds = computed(() => stageBuckets.value.backlog.filter((t) => t.status === "pending").map((t) => t.id));
const canReorderPending = computed(() => pendingBacklogIds.value.length > 1 && !queueIsRunning.value);

const draggingPendingTaskId = ref<string | null>(null);
const dropTargetPendingTaskId = ref<string | null>(null);
const dropTargetPosition = ref<"before" | "after">("before");
let suppressTaskRowClick = false;

function scheduleSuppressTaskRowClick(): void {
  suppressTaskRowClick = true;
  setTimeout(() => {
    suppressTaskRowClick = false;
  }, 0);
}

function onTaskRowClick(taskId: string): void {
  if (suppressTaskRowClick) return;
  emit("select", taskId);
  if (editingId.value) return;
  detailId.value = taskId;
}

function canDragPendingTask(task: Task): boolean {
  if (!canReorderPending.value) return false;
  if (task.status !== "pending") return false;
  return isActionAllowed(task, "reorder");
}

function onPendingTaskDragStart(ev: DragEvent, taskId: string): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  if (!pendingBacklogIds.value.includes(id)) return;
  if (!canReorderPending.value) return;

  draggingPendingTaskId.value = id;
  dropTargetPendingTaskId.value = null;
  dropTargetPosition.value = "before";
  try {
    ev.dataTransfer?.setData("text/plain", id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
  } catch {
    // ignore
  }
}

function onPendingTaskDragEnd(): void {
  draggingPendingTaskId.value = null;
  dropTargetPendingTaskId.value = null;
  dropTargetPosition.value = "before";
}

function onPendingTaskDragOver(ev: DragEvent, targetTaskId: string): void {
  const dragging = draggingPendingTaskId.value;
  const targetId = String(targetTaskId ?? "").trim();
  if (!dragging) return;
  if (!canReorderPending.value) return;
  if (!targetId) return;
  if (dragging === targetId) return;
  if (!pendingBacklogIds.value.includes(targetId)) return;

  ev.preventDefault();
  try {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  } catch {
    // ignore
  }

  dropTargetPendingTaskId.value = targetId;
  const el = ev.currentTarget as HTMLElement | null;
  if (!el) {
    dropTargetPosition.value = "before";
    return;
  }
  const rect = el.getBoundingClientRect();
  const midpoint = rect.top + rect.height / 2;
  dropTargetPosition.value = ev.clientY > midpoint ? "after" : "before";
}

function onPendingTaskDrop(ev: DragEvent, targetTaskId: string): void {
  const dragging = draggingPendingTaskId.value;
  const targetId = String(targetTaskId ?? "").trim();
  const position = dropTargetPosition.value;
  if (dragging) scheduleSuppressTaskRowClick();
  onPendingTaskDragEnd();

  if (!dragging) return;
  if (!canReorderPending.value) return;
  if (!targetId) return;
  if (!pendingBacklogIds.value.includes(targetId)) return;
  if (dragging === targetId) return;

  ev.preventDefault();

  const ids = pendingBacklogIds.value.slice();
  const fromIdx = ids.indexOf(dragging);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0) return;

  ids.splice(fromIdx, 1);
  const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
  const insertAt = position === "after" ? adjustedTo + 1 : adjustedTo;
  ids.splice(Math.max(0, Math.min(ids.length, insertAt)), 0, dragging);
  emit("reorder", ids);
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
          <button class="stageHeader" type="button" :aria-expanded="!stageCollapsed[section.stage]" @click="toggleStageCollapse(section.stage)">
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
                <button class="row-main" type="button" aria-label="查看任务详情" @click="onTaskRowClick(t.id)">
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
                    class="iconBtn primary" type="button" title="重新执行" aria-label="重新执行" :disabled="Boolean(editingId)"
                    @click.stop="startEdit(t)">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd"
                        d="M10 3a7 7 0 1 0 7 7 .75.75 0 0 0-1.5 0 5.5 5.5 0 1 1-1.38-3.65l-1.62 1.6a.75.75 0 0 0 .53 1.28H17a.75.75 0 0 0 .75-.75V3.5a.75.75 0 0 0-1.28-.53l-1.13 1.12A6.98 6.98 0 0 0 10 3Z"
                        clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'edit') && canEditTask(t) && !canRerunTask(t) && editingId !== t.id"
                    class="iconBtn" type="button" title="编辑" aria-label="编辑任务" :disabled="Boolean(editingId)" data-testid="task-edit"
                    @click.stop="startEdit(t)">
                    <el-icon :size="16" aria-hidden="true" class="icon">
                      <Edit />
                    </el-icon>
                  </button>
                  <button v-if="editingId === t.id" class="iconBtn" type="button" title="取消编辑" aria-label="取消编辑"
                    @click.stop="stopEdit()">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd"
                        d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 1 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
                        clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'cancel') && (t.status === 'running' || t.status === 'planning')"
                    class="iconBtn danger" type="button" title="终止任务" aria-label="终止任务" @click.stop="emit('cancel', t.id)">
                    <span class="interruptSpinner" aria-hidden="true" />
                  </button>
                  <button v-if="isActionAllowed(t, 'retry') && t.status === 'failed'" class="iconBtn" type="button"
                    title="重试" aria-label="重试任务" @click.stop="emit('retry', t.id)">
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path fill-rule="evenodd"
                        d="M10 4a6 6 0 0 0-5.2 9h2.1a1 1 0 0 1 .8 1.6l-2.4 3.2a1 1 0 0 1-1.6 0l-2.4-3.2A1 1 0 0 1 2.1 13h1.2A8 8 0 1 1 10 18a.75.75 0 0 1 0-1.5A6.5 6.5 0 1 0 3.62 10a.75.75 0 1 1-1.5 0A8 8 0 0 1 10 2a.75.75 0 0 1 0 1.5Z"
                        clip-rule="evenodd" />
                    </svg>
                  </button>
                  <button v-if="isActionAllowed(t, 'delete')" class="iconBtn danger" type="button" title="删除任务" aria-label="删除任务"
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

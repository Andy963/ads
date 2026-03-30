import { computed, ref, watch, type Ref } from "vue";

import type { Task } from "../../api/types";
import { deriveTaskStage, type TaskStage } from "../../lib/task_stage";

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
      .map((char) => `${char}${char}`)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }
  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const value = normalized.slice(1);
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b };
}

function toHexChannel(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
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

function srgbToLinear(value: number): number {
  const s = value / 255;
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

function defaultStageCollapsed(): Record<TaskStage, boolean> {
  return {
    backlog: true,
    in_progress: true,
    in_review: true,
    done: true,
  };
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

export function statusLabel(status: string): string {
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

export function reviewBadge(task: Task): { label: string; status: Task["reviewStatus"]; title?: string } | null {
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

export function useTaskBoardStages(params: {
  tasks: Ref<Task[]>;
  workspaceRoot: Ref<string | null | undefined>;
}) {
  const stageBuckets = computed(() => {
    const buckets: Record<TaskStage, Task[]> = {
      backlog: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const task of params.tasks.value) {
      buckets[deriveTaskStage(task)].push(task);
    }

    buckets.backlog.sort(compareBacklogTasks);
    buckets.in_progress.sort(compareInProgressTasks);
    buckets.in_review.sort(compareInReviewTasks);
    buckets.done.sort(compareDoneTasks);
    return buckets;
  });

  const stageSections = computed(() => {
    const buckets = stageBuckets.value;
    const stages: TaskStage[] = ["backlog", "in_progress", "in_review", "done"];
    return stages.map((stage) => ({
      stage,
      title: stageTitle(stage),
      tasks: buckets[stage],
      testId: `task-stage-${stage}`,
    }));
  });

  const totalVisibleTasks = computed(() =>
    stageSections.value.reduce((sum, section) => sum + section.tasks.length, 0),
  );

  const stageCollapsed = ref<Record<TaskStage, boolean>>(defaultStageCollapsed());

  watch(
    () => String(params.workspaceRoot.value ?? "").trim(),
    (next, prev) => {
      if (next === prev) return;
      stageCollapsed.value = defaultStageCollapsed();
    },
  );

  function toggleStageCollapse(stage: TaskStage): void {
    stageCollapsed.value[stage] = !stageCollapsed.value[stage];
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

  return {
    stageBuckets,
    stageSections,
    totalVisibleTasks,
    stageCollapsed,
    toggleStageCollapse,
    taskColorVars,
    statusLabel,
    reviewBadge,
  };
}

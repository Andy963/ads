import type {
  ReviewAutomationMode,
  ReviewActionAudit,
  ReviewControlState,
  TaskReviewStatus,
  TaskReviewSummary,
} from "./types.js";

export function toReviewActionAudit(row: Record<string, unknown>): ReviewActionAudit {
  return {
    id: String(row.id ?? ""),
    taskId: String(row.task_id ?? ""),
    rootTaskId: String(row.root_task_id ?? ""),
    action: String(row.action ?? "") as ReviewActionAudit["action"],
    reason: nullableString(row.reason),
    actorId: String(row.actor_id ?? ""),
    createdAt: nullableNumber(row.created_at) ?? 0,
  };
}

const REVIEW_STATUS_VALUES = new Set<TaskReviewStatus>([
  "none",
  "pending_review",
  "in_review",
  "approved",
  "rejected",
  "skipped",
  "needs_human_intervention",
  "error",
]);

const AUTOMATION_MODE_VALUES = new Set<ReviewAutomationMode>(["auto_with_fuse", "human_gated"]);

const CONTROL_STATE_VALUES = new Set<ReviewControlState>([
  "automatic",
  "human_gated",
  "needs_intervention",
]);

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const normalized = nullableNumber(value);
  return normalized == null ? fallback : Math.max(0, Math.floor(normalized));
}

function reviewStatus(value: unknown): TaskReviewStatus {
  const normalized = String(value ?? "").trim().toLowerCase() as TaskReviewStatus;
  return REVIEW_STATUS_VALUES.has(normalized) ? normalized : "none";
}

function automationMode(value: unknown): ReviewAutomationMode {
  const normalized = String(value ?? "").trim().toLowerCase() as ReviewAutomationMode;
  return AUTOMATION_MODE_VALUES.has(normalized) ? normalized : "auto_with_fuse";
}

function controlState(value: unknown, status: TaskReviewStatus, mode: ReviewAutomationMode): ReviewControlState {
  const normalized = String(value ?? "").trim() as ReviewControlState;
  if (CONTROL_STATE_VALUES.has(normalized)) return normalized;
  if (status === "needs_human_intervention") return "needs_intervention";
  return mode === "human_gated" ? "human_gated" : "automatic";
}

export function defaultTaskReviewSummary(overrides?: Partial<TaskReviewSummary>): TaskReviewSummary {
  const status = reviewStatus(overrides?.status);
  const mode = automationMode(overrides?.automationMode);
  return {
    required: Boolean(overrides?.required),
    status,
    rootTaskId: nullableString(overrides?.rootTaskId),
    pullRequestNumber: nullableNumber(overrides?.pullRequestNumber),
    pullRequestUrl: nullableString(overrides?.pullRequestUrl),
    reviewTaskId: nullableString(overrides?.reviewTaskId),
    reviewerModelConfigId: nullableString(overrides?.reviewerModelConfigId),
    reviewerModelId: nullableString(overrides?.reviewerModelId),
    reviewerModelDisplayName: nullableString(overrides?.reviewerModelDisplayName),
    reviewerAgentId: nullableString(overrides?.reviewerAgentId),
    reviewStartedAt: nullableNumber(overrides?.reviewStartedAt),
    reviewedAt: nullableNumber(overrides?.reviewedAt),
    conclusion: nullableString(overrides?.conclusion),
    feedback: nullableString(overrides?.feedback),
    output: nullableString(overrides?.output),
    artifactId: nullableString(overrides?.artifactId),
    reworkRound: nonNegativeInteger(overrides?.reworkRound, 0),
    maxReworkRounds: nonNegativeInteger(overrides?.maxReworkRounds, 2),
    automationMode: mode,
    stateReason: nullableString(overrides?.stateReason),
    reworkTaskIds: Array.isArray(overrides?.reworkTaskIds)
      ? overrides.reworkTaskIds.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [],
    controlState: controlState(overrides?.controlState, status, mode),
  };
}

export function parseTaskReviewSummary(raw: unknown, legacy?: {
  required?: unknown;
  status?: unknown;
  snapshotId?: unknown;
  conclusion?: unknown;
  reviewedAt?: unknown;
}): TaskReviewSummary {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<TaskReviewSummary> : {};
  const summary = defaultTaskReviewSummary({
    ...value,
    required: value.required ?? (legacy?.required == null ? undefined : Boolean(legacy.required)),
    status: value.status ?? (legacy?.status == null ? undefined : reviewStatus(legacy.status)),
    artifactId: value.artifactId ?? nullableString(legacy?.snapshotId),
    conclusion: value.conclusion ?? nullableString(legacy?.conclusion),
    reviewedAt: value.reviewedAt ?? nullableNumber(legacy?.reviewedAt),
  });
  return summary;
}

export function reviewSummaryJson(summary: TaskReviewSummary): string {
  return JSON.stringify(defaultTaskReviewSummary(summary));
}

export function isTerminalReviewStatus(status: TaskReviewStatus): boolean {
  return status === "approved" || status === "skipped" || status === "needs_human_intervention" || status === "error";
}

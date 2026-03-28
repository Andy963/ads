import type {
  ConversationStatus,
  TaskExecutionIsolation,
  TaskReviewStatus,
  TaskRole,
  TaskRunApplyStatus,
  TaskRunCaptureStatus,
  TaskRunStatus,
  TaskStatus,
} from "../types.js";

import { safeParseJsonFromUnknown } from "../../utils/json.js";

export function parseJson<T>(raw: unknown): T | null {
  return safeParseJsonFromUnknown<T>(raw);
}

export function normalizeNullableString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const raw = String(value).trim();
  return raw || null;
}

export function normalizeTaskModel(value: unknown): string {
  return normalizeNullableString(value) ?? "auto";
}

export function normalizeTaskStatus(value: unknown): TaskStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "queued":
    case "pending":
    case "planning":
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return "pending";
  }
}

export function normalizeTaskReviewStatus(value: unknown): TaskReviewStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "none":
    case "pending":
    case "running":
    case "passed":
    case "rejected":
    case "failed":
      return raw;
    default:
      return "none";
  }
}

export function normalizeTaskExecutionIsolation(value: unknown): TaskExecutionIsolation {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "required":
      return "required";
    default:
      return "default";
  }
}

export function normalizeTaskRunStatus(value: unknown): TaskRunStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "preparing":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return "preparing";
  }
}

export function normalizeTaskCaptureStatus(value: unknown): TaskRunCaptureStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "pending":
    case "ok":
    case "failed":
    case "skipped":
      return raw;
    default:
      return "pending";
  }
}

export function normalizeTaskApplyStatus(value: unknown): TaskRunApplyStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "pending":
    case "applied":
    case "blocked":
    case "failed":
    case "skipped":
      return raw;
    default:
      return "pending";
  }
}

export function normalizeRole(value: unknown): TaskRole {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "system":
    case "user":
    case "assistant":
    case "tool":
      return raw;
    default:
      return "system";
  }
}

export function normalizeConversationStatus(value: unknown): ConversationStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "active":
    case "archived":
      return raw;
    default:
      return "active";
  }
}

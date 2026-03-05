import type { ConversationStatus, TaskReviewStatus, TaskRole, TaskStatus } from "../types.js";

import { safeParseJsonFromUnknown } from "../../utils/json.js";

export function parseJson<T>(raw: unknown): T | null {
  return safeParseJsonFromUnknown<T>(raw);
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
      return raw;
    default:
      return "none";
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

import type { ConversationStatus, TaskRole, TaskStatus } from "../types.js";

export function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
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

import {
  buildTaskAttachments,
  readJsonBodyOrSendBadRequest,
  resolveTaskContextOrSendBadRequest,
  type JsonBodyResult,
  type ResolvedTaskContext,
} from "../shared.js";

export function parseTaskStatus(value: string | undefined | null):
  | "queued"
  | "pending"
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
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
      return undefined;
  }
}

export { buildTaskAttachments, readJsonBodyOrSendBadRequest, resolveTaskContextOrSendBadRequest };
export type { JsonBodyResult, ResolvedTaskContext };

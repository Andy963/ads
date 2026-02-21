import fs from "node:fs";

import { TaskStore } from "../../tasks/store_impl.js";
import type { Task } from "../../tasks/types.js";
import type { TaskBundle } from "../../web/server/planner/taskBundle.js";
import { normalizeCreateTaskInput } from "../../web/server/planner/taskBundleApprover.js";
import type { TaskBundleDraft } from "../../web/server/planner/taskBundleDraftStore.js";
import {
  approveTaskBundleDraft,
  cancelTaskBundleDraft,
  getTaskBundleDraft,
  upsertTaskBundleDraft,
} from "../../web/server/planner/taskBundleDraftStore.js";

export const TELEGRAM_TASK_DRAFT_NAMESPACE = "telegram";

export function deriveTelegramAuthUserId(userId: number): string {
  if (!Number.isFinite(userId)) {
    throw new Error("userId must be a finite number");
  }
  return `tg:${Math.floor(userId)}`;
}

export function buildTelegramTaskBundleFromText(text: string): TaskBundle {
  const prompt = String(text ?? "").trim();
  if (!prompt) {
    throw new Error("text is required");
  }

  return {
    version: 1,
    tasks: [{ prompt }],
  };
}

export function createTelegramTaskDraft(args: {
  authUserId: string;
  workspaceRoot: string;
  sourceChatSessionId: string;
  text: string;
  now?: number;
}): TaskBundleDraft {
  const authUserId = String(args.authUserId ?? "").trim();
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const sourceChatSessionId = String(args.sourceChatSessionId ?? "").trim();
  if (!authUserId) {
    throw new Error("authUserId is required");
  }
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is required");
  }
  if (!sourceChatSessionId) {
    throw new Error("sourceChatSessionId is required");
  }

  const bundle = buildTelegramTaskBundleFromText(args.text);
  return upsertTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    workspaceRoot,
    sourceChatSessionId,
    bundle,
    now: args.now,
  });
}

export function getTelegramTaskDraft(args: { authUserId: string; draftId: string }): TaskBundleDraft | null {
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  if (!authUserId || !draftId) return null;

  return getTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
  });
}

export type ConfirmTelegramTaskDraftResult =
  | { status: "not_found" }
  | { status: "cancelled"; workspaceRoot: string }
  | { status: "already_approved"; workspaceRoot: string; createdTaskIds: string[] }
  | { status: "workspace_unavailable"; workspaceRoot: string }
  | { status: "ok"; workspaceRoot: string; createdTaskIds: string[] }
  | { status: "error"; workspaceRoot: string; error: string };

function isWorkspaceRootAvailable(workspaceRoot: string): boolean {
  if (!workspaceRoot) {
    return false;
  }
  try {
    const stat = fs.statSync(workspaceRoot);
    if (!stat.isDirectory()) {
      return false;
    }
    fs.accessSync(workspaceRoot, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function createQueuedTaskOrReuseExisting(args: {
  taskStore: TaskStore;
  createInput: Parameters<TaskStore["createTask"]>[0];
  now: number;
}): { ok: true; task: Task } | { ok: false; error: string } {
  try {
    const task = args.taskStore.createTask(args.createInput, args.now, { status: "queued" });
    return { ok: true, task };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const existing = args.createInput.id ? args.taskStore.getTask(args.createInput.id) : null;
    if (existing) {
      return { ok: true, task: existing };
    }
    return { ok: false, error: message };
  }
}

export function confirmTelegramTaskDraft(args: {
  authUserId: string;
  draftId: string;
  now?: number;
}): ConfirmTelegramTaskDraftResult {
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  if (!authUserId || !draftId) {
    return { status: "not_found" };
  }

  const existing = getTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
  });

  if (!existing) {
    return { status: "not_found" };
  }

  if (existing.status === "deleted") {
    return { status: "cancelled", workspaceRoot: existing.workspaceRoot };
  }

  if (existing.status === "approved") {
    return {
      status: "already_approved",
      workspaceRoot: existing.workspaceRoot,
      createdTaskIds: existing.approvedTaskIds,
    };
  }

  if (!existing.bundle) {
    return { status: "error", workspaceRoot: existing.workspaceRoot, error: "Draft bundle is not available" };
  }

  if (!isWorkspaceRootAvailable(existing.workspaceRoot)) {
    return { status: "workspace_unavailable", workspaceRoot: existing.workspaceRoot };
  }

  const taskStore = new TaskStore({ workspacePath: existing.workspaceRoot });
  const createdTaskIds: string[] = [];

  for (let index = 0; index < existing.bundle.tasks.length; index += 1) {
    const specTask = existing.bundle.tasks[index]!;
    const normalized = normalizeCreateTaskInput(draftId, specTask, index, "telegram_draft");
    const { attachments: _attachments, ...createInput } = normalized;
    const res = createQueuedTaskOrReuseExisting({ taskStore, createInput, now });
    if (!res.ok) {
      return {
        status: "error",
        workspaceRoot: existing.workspaceRoot,
        error: `Create task failed (idx=${index + 1}): ${res.error}`,
      };
    }
    createdTaskIds.push(res.task.id);
  }

  const approved = approveTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
    approvedTaskIds: createdTaskIds,
    now,
  });

  if (approved) {
    return { status: "ok", workspaceRoot: existing.workspaceRoot, createdTaskIds };
  }

  const reread = getTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
  });

  if (reread && reread.status === "approved") {
    return { status: "already_approved", workspaceRoot: reread.workspaceRoot, createdTaskIds: reread.approvedTaskIds };
  }

  return { status: "error", workspaceRoot: existing.workspaceRoot, error: "Failed to mark draft as approved" };
}

export type CancelTelegramTaskDraftResult =
  | { status: "not_found" }
  | { status: "already_cancelled" }
  | { status: "already_approved"; workspaceRoot: string; createdTaskIds: string[] }
  | { status: "cancelled"; workspaceRoot: string }
  | { status: "error"; workspaceRoot: string; error: string };

export function cancelTelegramTaskDraft(args: {
  authUserId: string;
  draftId: string;
  now?: number;
}): CancelTelegramTaskDraftResult {
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  if (!authUserId || !draftId) {
    return { status: "not_found" };
  }

  const existing = getTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
  });

  if (!existing) {
    return { status: "not_found" };
  }

  if (existing.status === "deleted") {
    return { status: "already_cancelled" };
  }

  if (existing.status === "approved") {
    return { status: "already_approved", workspaceRoot: existing.workspaceRoot, createdTaskIds: existing.approvedTaskIds };
  }

  const outcome = cancelTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
    now,
  });

  if (outcome.ok) {
    return { status: "cancelled", workspaceRoot: existing.workspaceRoot };
  }

  const reread = getTaskBundleDraft({
    namespace: TELEGRAM_TASK_DRAFT_NAMESPACE,
    authUserId,
    draftId,
  });
  if (reread && reread.status === "deleted") {
    return { status: "already_cancelled" };
  }
  if (reread && reread.status === "approved") {
    return { status: "already_approved", workspaceRoot: reread.workspaceRoot, createdTaskIds: reread.approvedTaskIds };
  }

  return { status: "error", workspaceRoot: existing.workspaceRoot, error: "Failed to cancel draft" };
}

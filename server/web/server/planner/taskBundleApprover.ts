import crypto from "node:crypto";

import type { TaskBundle, TaskBundleTask } from "./taskBundle.js";
import { resolveTaskBundleExecutionIsolation } from "./taskBundle.js";
import type { Attachment } from "../../../attachments/types.js";
import type { CreateTaskInput, Task } from "../../../tasks/types.js";
import { recordTaskQueueMetric, type TaskQueueMetrics } from "../taskQueue/manager.js";

type TaskStoreLike = {
  createTask: (input: CreateTaskInput, now: number, options: { status: "queued" }) => Task;
  getTask: (id: string) => Task | null;
  deleteTask: (id: string) => void;
};

type AttachmentStoreLike = {
  assignAttachmentsToTask: (taskId: string, attachmentIds: string[]) => void;
  listAttachmentsForTask: (taskId: string) => Attachment[];
};

export type TaskAttachmentPayload = {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  filename: string | null;
};

export type MaterializedDraftTask = {
  task: Task & { attachments?: TaskAttachmentPayload[] };
  title: string;
};

function buildTaskAttachmentPayloads(
  taskId: string,
  attachmentStore: AttachmentStoreLike,
  buildAttachmentUrl?: ((attachmentId: string) => string) | null,
): TaskAttachmentPayload[] | undefined {
  const attachments = attachmentStore.listAttachmentsForTask(taskId);
  if (attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    id: attachment.id,
    url: buildAttachmentUrl ? buildAttachmentUrl(attachment.id) : "",
    sha256: attachment.sha256,
    width: attachment.width,
    height: attachment.height,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    filename: attachment.filename ?? null,
  }));
}

export function buildWorkspaceAttachmentRawUrl(workspaceRoot: string, attachmentId: string): string {
  const normalizedId = encodeURIComponent(String(attachmentId ?? "").trim());
  const normalizedWorkspace = String(workspaceRoot ?? "").trim();
  if (!normalizedWorkspace) {
    return `/api/attachments/${normalizedId}/raw`;
  }
  return `/api/attachments/${normalizedId}/raw?workspace=${encodeURIComponent(normalizedWorkspace)}`;
}

export function deriveStableUuid(input: string): string {
  const hash = crypto.createHash("sha256").update(input).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveStableTaskId(draftId: string, task: TaskBundleTask, index: number): string {
  const external = String(task.externalId ?? "").trim();
  const suffix = external ? external : `#${index + 1}`;
  return deriveStableUuid(`${draftId}::${suffix}`);
}

export function normalizeTaskTitle(task: TaskBundleTask): string | undefined {
  const raw = String(task.title ?? "").trim();
  if (raw) return raw;
  const prompt = String(task.prompt ?? "");
  const firstLine = prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const base = (firstLine ?? "").replace(/\s+/g, " ").trim();
  if (!base) return undefined;
  const maxLen = 80;
  return base.length <= maxLen ? base : `${base.slice(0, maxLen)}…`;
}

export function normalizeCreateTaskInput(
  originId: string,
  task: TaskBundleTask,
  index: number,
  createdBy?: string,
  bundle?: Pick<TaskBundle, "defaults"> | null,
): {
  id: string;
  title?: string;
  prompt: string;
  model?: string;
  priority?: number;
  inheritContext?: boolean;
  maxRetries?: number;
  createdBy: string;
  attachments?: string[];
} & CreateTaskInput {
  const prompt = String(task.prompt ?? "");
  const id = deriveStableTaskId(originId, task, index);
  const title = normalizeTaskTitle(task);
  const model = String(task.model ?? "").trim();
  const priority = typeof task.priority === "number" && Number.isFinite(task.priority) ? task.priority : undefined;
  const inheritContext = typeof task.inheritContext === "boolean" ? task.inheritContext : undefined;
  const maxRetries =
    typeof task.maxRetries === "number" && Number.isFinite(task.maxRetries) ? Math.max(0, Math.floor(task.maxRetries)) : undefined;
  const attachments = (task.attachments ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
  const executionIsolation = resolveTaskBundleExecutionIsolation(bundle, task);
  return {
    id,
    title,
    prompt,
    model: model || undefined,
    priority,
    inheritContext,
    maxRetries,
    executionIsolation,
    reviewRequired: true,
    createdBy: createdBy ?? "planner_draft",
    attachments: attachments.length ? attachments : undefined,
  };
}

export function materializeTaskBundleTasks(args: {
  draftId: string;
  bundleDefaults?: Pick<TaskBundle, "defaults"> | null;
  tasks: TaskBundleTask[];
  now: number;
  taskStore: TaskStoreLike;
  attachmentStore: AttachmentStoreLike;
  metrics: TaskQueueMetrics;
  metricReason: string;
  buildAttachmentUrl?: (attachmentId: string) => string;
  createTaskErrorPrefix?: string;
  onTaskMaterialized?: (record: MaterializedDraftTask) => void;
}): {
  createdTaskIds: string[];
  taskTitles: string[];
  createdTasks: MaterializedDraftTask[];
} {
  const createdTaskIds: string[] = [];
  const taskTitles: string[] = [];
  const createdTasks: MaterializedDraftTask[] = [];

  for (let i = 0; i < args.tasks.length; i++) {
    const specTask = args.tasks[i]!;
    const input = normalizeCreateTaskInput(args.draftId, specTask, i, undefined, args.bundleDefaults);
    const attachmentIds = (input.attachments ?? []).slice();
    const { attachments: _attachments, ...createInput } = input;

    let task = null as Task | null;
    let createdFresh = false;
    try {
      task = args.taskStore.createTask(createInput, args.now, { status: "queued" });
      createdFresh = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existingTask = args.taskStore.getTask(input.id);
      if (!existingTask) {
        const prefix = args.createTaskErrorPrefix ?? "Create task failed";
        throw new Error(`${prefix} (idx=${i + 1}): ${message}`);
      }
      task = existingTask;
    }

    if (attachmentIds.length > 0) {
      try {
        args.attachmentStore.assignAttachmentsToTask(task.id, attachmentIds);
      } catch (error) {
        if (createdFresh) {
          try {
            args.taskStore.deleteTask(task.id);
          } catch {
            // ignore
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Assign attachments failed (idx=${i + 1}): ${message}`);
      }
    }

    const attachments = buildTaskAttachmentPayloads(task.id, args.attachmentStore, args.buildAttachmentUrl);
    const taskWithAttachments = attachments ? { ...task, attachments } : task;

    recordTaskQueueMetric(args.metrics, "TASK_ADDED", {
      ts: args.now,
      taskId: task.id,
      reason: args.metricReason,
    });

    const title = task.title ?? "";
    const record: MaterializedDraftTask = { task: taskWithAttachments, title };
    createdTaskIds.push(task.id);
    taskTitles.push(title);
    createdTasks.push(record);
    args.onTaskMaterialized?.(record);
  }

  return { createdTaskIds, taskTitles, createdTasks };
}

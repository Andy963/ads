import crypto from "node:crypto";
import type { TaskBundleTask } from "./taskBundle.js";
import type { CreateTaskInput } from "../../../tasks/types.js";

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
  return {
    id,
    title,
    prompt,
    model: model || undefined,
    priority,
    inheritContext,
    maxRetries,
    createdBy: createdBy ?? "planner_draft",
    attachments: attachments.length ? attachments : undefined,
  };
}

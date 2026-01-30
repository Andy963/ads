import type { PlanStep, Task, TaskMessage } from "../types.js";
import { normalizePlanStepStatus, normalizeRole, normalizeTaskStatus, parseJson } from "./normalize.js";

export function toTask(row: Record<string, unknown>): Task {
  const createdAt = typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0);
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    prompt: String(row.prompt ?? ""),
    model: String(row.model ?? "auto"),
    modelParams: parseJson<Record<string, unknown>>(row.model_params),
    status: normalizeTaskStatus(row.status),
    priority: typeof row.priority === "number" ? row.priority : Number(row.priority ?? 0),
    queueOrder:
      typeof row.queue_order === "number"
        ? row.queue_order
        : row.queue_order == null
          ? createdAt
          : Number(row.queue_order),
    queuedAt: row.queued_at == null ? null : (typeof row.queued_at === "number" ? row.queued_at : Number(row.queued_at)),
    promptInjectedAt:
      row.prompt_injected_at == null
        ? null
        : (typeof row.prompt_injected_at === "number" ? row.prompt_injected_at : Number(row.prompt_injected_at)),
    inheritContext: Boolean(row.inherit_context),
    parentTaskId: row.parent_task_id == null ? null : String(row.parent_task_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    result: row.result == null ? null : String(row.result),
    error: row.error == null ? null : String(row.error),
    retryCount: typeof row.retry_count === "number" ? row.retry_count : Number(row.retry_count ?? 0),
    maxRetries: typeof row.max_retries === "number" ? row.max_retries : Number(row.max_retries ?? 3),
    createdAt,
    startedAt: row.started_at == null ? null : (typeof row.started_at === "number" ? row.started_at : Number(row.started_at)),
    completedAt: row.completed_at == null ? null : (typeof row.completed_at === "number" ? row.completed_at : Number(row.completed_at ?? 0)),
    createdBy: row.created_by == null ? null : String(row.created_by),
  };
}

export function toPlanStep(row: Record<string, unknown>): PlanStep {
  return {
    id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
    taskId: String(row.task_id ?? ""),
    stepNumber: typeof row.step_number === "number" ? row.step_number : Number(row.step_number ?? 0),
    title: String(row.title ?? ""),
    description: row.description == null ? null : String(row.description),
    status: normalizePlanStepStatus(row.status),
    startedAt: row.started_at == null ? null : (typeof row.started_at === "number" ? row.started_at : Number(row.started_at ?? 0)),
    completedAt: row.completed_at == null ? null : (typeof row.completed_at === "number" ? row.completed_at : Number(row.completed_at ?? 0)),
  };
}

export function toTaskMessage(row: Record<string, unknown>): TaskMessage {
  return {
    id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
    taskId: String(row.task_id ?? ""),
    planStepId: row.plan_step_id == null ? null : (typeof row.plan_step_id === "number" ? row.plan_step_id : Number(row.plan_step_id)),
    role: normalizeRole(row.role),
    content: String(row.content ?? ""),
    messageType: row.message_type == null ? null : String(row.message_type),
    modelUsed: row.model_used == null ? null : String(row.model_used),
    tokenCount: row.token_count == null ? null : (typeof row.token_count === "number" ? row.token_count : Number(row.token_count)),
    createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
  };
}


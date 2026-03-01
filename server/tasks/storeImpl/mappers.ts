import type { Conversation, ConversationMessage, ModelConfig, Task, TaskMessage } from "../types.js";
import { normalizeConversationStatus, normalizeRole, normalizeTaskStatus, parseJson } from "./normalize.js";

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : Number(value ?? fallback);
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  return typeof value === "number" ? value : Number(value);
}

export function toTask(row: Record<string, unknown>): Task {
  const createdAt = toNumber(row.created_at);
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    prompt: String(row.prompt ?? ""),
    model: String(row.model ?? "auto"),
    modelParams: parseJson<Record<string, unknown>>(row.model_params),
    status: normalizeTaskStatus(row.status),
    priority: toNumber(row.priority),
    queueOrder: row.queue_order == null ? createdAt : toNumber(row.queue_order),
    queuedAt: toNullableNumber(row.queued_at),
    promptInjectedAt: toNullableNumber(row.prompt_injected_at),
    inheritContext: Boolean(row.inherit_context),
    agentId: row.agent_id == null ? null : (String(row.agent_id ?? "").trim() || null),
    parentTaskId: row.parent_task_id == null ? null : String(row.parent_task_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    result: row.result == null ? null : String(row.result),
    error: row.error == null ? null : String(row.error),
    retryCount: toNumber(row.retry_count),
    maxRetries: toNumber(row.max_retries, 3),
    createdAt,
    startedAt: toNullableNumber(row.started_at),
    completedAt: toNullableNumber(row.completed_at),
    archivedAt: toNullableNumber(row.archived_at),
    createdBy: row.created_by == null ? null : String(row.created_by),
  };
}

export function toTaskMessage(row: Record<string, unknown>): TaskMessage {
  return {
    id: toNumber(row.id),
    taskId: String(row.task_id ?? ""),
    planStepId: toNullableNumber(row.plan_step_id),
    role: normalizeRole(row.role),
    content: String(row.content ?? ""),
    messageType: row.message_type == null ? null : String(row.message_type),
    modelUsed: row.model_used == null ? null : String(row.model_used),
    tokenCount: toNullableNumber(row.token_count),
    createdAt: toNumber(row.created_at),
  };
}

export function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id ?? ""),
    taskId: row.task_id == null ? null : String(row.task_id),
    title: row.title == null ? null : String(row.title),
    totalTokens: toNumber(row.total_tokens),
    lastModel: row.last_model == null ? null : String(row.last_model),
    modelResponseIds: parseJson<Record<string, string>>(row.model_response_ids) ?? null,
    status: normalizeConversationStatus(row.status),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  };
}

export function toConversationMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    id: toNumber(row.id),
    conversationId: String(row.conversation_id ?? ""),
    taskId: row.task_id == null ? null : String(row.task_id),
    role: normalizeRole(row.role),
    content: String(row.content ?? ""),
    modelId: row.model_id == null ? null : String(row.model_id),
    tokenCount: toNullableNumber(row.token_count),
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? null,
    createdAt: toNumber(row.created_at),
  };
}

export function toModelConfig(row: Record<string, unknown>): ModelConfig {
  return {
    id: String(row.id ?? ""),
    displayName: String(row.display_name ?? ""),
    provider: String(row.provider ?? ""),
    isEnabled: Boolean(row.is_enabled),
    isDefault: Boolean(row.is_default),
    configJson: parseJson<Record<string, unknown>>(row.config_json) ?? null,
    updatedAt: toNullableNumber(row.updated_at),
  };
}

import crypto from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { getWorkspacesDatabase, resolveWorkspaceId } from "../storage/database.js";
import { type TaskStoreStatements, prepareTaskStoreStatements } from "./storeStatements.js";
import type {
  CreateTaskInput,
  CreateTaskRunInput,
  Conversation,
  ConversationMessage,
  ModelConfig,
  ReviewAction,
  ReviewActionAudit,
  ReviewSettings,
  Task,
  TaskContext,
  TaskFilter,
  TaskMessage,
  TaskRun,
  TaskStatus,
  TaskCategory,
  TaskReviewSummary,
} from "./types.js";
import { defaultTaskReviewSummary, toReviewActionAudit } from "./reviewData.js";

import { createTaskStoreConversationOps } from "./storeImpl/conversationOps.js";
import { createTaskStoreMessageOps } from "./storeImpl/messageOps.js";
import { createTaskStoreModelConfigOps } from "./storeImpl/modelConfigOps.js";
import { createTaskStoreTaskOps } from "./storeImpl/taskOps.js";

export class TaskStore {
  private readonly db: DatabaseType;
  private readonly stmts: TaskStoreStatements;

  private readonly taskOps: ReturnType<typeof createTaskStoreTaskOps>;
  private readonly messageOps: ReturnType<typeof createTaskStoreMessageOps>;
  private readonly modelConfigOps: ReturnType<typeof createTaskStoreModelConfigOps>;
  private readonly conversationOps: ReturnType<typeof createTaskStoreConversationOps>;

  constructor(options?: { workspacePath?: string }) {
    this.db = getWorkspacesDatabase(undefined, options?.workspacePath);
    const workspaceId = resolveWorkspaceId(options?.workspacePath);
    this.stmts = prepareTaskStoreStatements(this.db, workspaceId);

    this.taskOps = createTaskStoreTaskOps({ db: this.db, stmts: this.stmts, workspaceId });
    this.messageOps = createTaskStoreMessageOps({ stmts: this.stmts });
    this.modelConfigOps = createTaskStoreModelConfigOps({ db: this.db, stmts: this.stmts });
    this.conversationOps = createTaskStoreConversationOps({ stmts: this.stmts });
  }

  createTask(
    input: CreateTaskInput,
    now = Date.now(),
    options?: { status?: TaskStatus; queuedAt?: number | null },
  ): Task {
    return this.taskOps.createTask(input, now, options);
  }

  getActiveTaskId(): string | null {
    return this.taskOps.getActiveTaskId();
  }

  dequeueNextQueuedTask(now = Date.now(), allowedTaskIds?: ReadonlySet<string>): Task | null {
    return this.taskOps.dequeueNextQueuedTask(now, allowedTaskIds);
  }

  getTask(id: string): Task | null {
    return this.taskOps.getTask(id);
  }

  findChildTask(parentTaskId: string, category: TaskCategory): Task | null {
    return this.taskOps.findChildTask(parentTaskId, category);
  }

  listChildTasks(parentTaskId: string): Task[] {
    return this.taskOps.listChildTasks(parentTaskId);
  }

  getRootTask(taskId: string): Task | null {
    let current = this.getTask(taskId);
    const seen = new Set<string>();
    while (current?.parentTaskId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.getTask(current.parentTaskId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  updateTaskReview(taskId: string, review: Partial<TaskReviewSummary>, now = Date.now()): Task {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    return this.updateTask(taskId, {
      review: defaultTaskReviewSummary({ ...(current.review ?? {}), ...review }),
    }, now);
  }

  getReviewSettings(): ReviewSettings {
    const row = this.stmts.getReviewSettingsStmt.get() as {
      automation_mode?: unknown;
      max_rework_rounds?: unknown;
      updated_at?: unknown;
    } | undefined;
    const rounds = Number(row?.max_rework_rounds);
    return {
      automationMode: row?.automation_mode === "human_gated" ? "human_gated" : "auto_with_fuse",
      maxReworkRounds: Number.isFinite(rounds) ? Math.max(0, Math.floor(rounds)) : 2,
      updatedAt: row?.updated_at == null ? null : Number(row.updated_at),
    };
  }

  upsertReviewSettings(input: Partial<ReviewSettings>, now = Date.now()): ReviewSettings {
    const current = this.getReviewSettings();
    const automationMode = input.automationMode === "human_gated"
      ? "human_gated"
      : input.automationMode === "auto_with_fuse" ? "auto_with_fuse" : current.automationMode;
    const requestedRounds = input.maxReworkRounds == null ? current.maxReworkRounds : Number(input.maxReworkRounds);
    if (!Number.isFinite(requestedRounds) || requestedRounds < 0) {
      throw new Error("maxReworkRounds must be a non-negative integer");
    }
    const maxReworkRounds = Math.floor(requestedRounds);
    this.stmts.upsertReviewSettingsStmt.run(automationMode, maxReworkRounds, now);
    return { automationMode, maxReworkRounds, updatedAt: now };
  }

  createReviewActionAudit(input: {
    taskId: string;
    rootTaskId: string;
    action: ReviewAction;
    reason?: string | null;
    actorId: string;
    idempotencyKey: string;
    now?: number;
  }): ReviewActionAudit {
    const idempotencyKey = String(input.idempotencyKey ?? "").trim();
    if (!idempotencyKey) throw new Error("idempotencyKey is required");
    const existing = this.stmts.getReviewActionAuditByIdempotencyStmt.get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return toReviewActionAudit(existing);
    const audit: ReviewActionAudit = {
      id: crypto.randomUUID(),
      taskId: String(input.taskId).trim(),
      rootTaskId: String(input.rootTaskId).trim(),
      action: input.action,
      reason: input.reason == null ? null : String(input.reason).trim() || null,
      actorId: String(input.actorId).trim() || "unknown",
      createdAt: input.now ?? Date.now(),
    };
    try {
      this.stmts.insertReviewActionAuditStmt.run(
        audit.id,
        audit.taskId,
        audit.rootTaskId,
        audit.action,
        audit.reason,
        audit.actorId,
        idempotencyKey,
        audit.createdAt,
      );
    } catch (error) {
      const concurrent = this.stmts.getReviewActionAuditByIdempotencyStmt.get(idempotencyKey) as Record<string, unknown> | undefined;
      if (concurrent) return toReviewActionAudit(concurrent);
      throw error;
    }
    return audit;
  }

  getReviewActionAuditByIdempotency(idempotencyKey: string): ReviewActionAudit | null {
    const normalized = String(idempotencyKey ?? "").trim();
    if (!normalized) return null;
    const row = this.stmts.getReviewActionAuditByIdempotencyStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? toReviewActionAudit(row) : null;
  }

  listReviewActionAudits(rootTaskId: string): ReviewActionAudit[] {
    return (this.stmts.listReviewActionAuditsStmt.all(String(rootTaskId ?? "").trim()) as Record<string, unknown>[]).map(toReviewActionAudit);
  }

  listTasks(filter?: TaskFilter): Task[] {
    return this.taskOps.listTasks(filter);
  }

  getMinPendingQueueOrder(): number | null {
    const row = this.stmts.selectMinPendingQueueOrderStmt.get() as { min?: unknown } | undefined;
    const value = row?.min;
    if (value == null) {
      return null;
    }
    const min = typeof value === "number" ? value : Number(value);
    return Number.isFinite(min) ? min : null;
  }

  updateTask(id: string, updates: Partial<Omit<Task, "id">>, now = Date.now()): Task {
    return this.taskOps.updateTask(id, updates, now);
  }

  createTaskRun(input: CreateTaskRunInput, now = Date.now()): TaskRun {
    return this.taskOps.createTaskRun(input, now);
  }

  getTaskRun(id: string): TaskRun | null {
    return this.taskOps.getTaskRun(id);
  }

  getLatestTaskRun(taskId: string): TaskRun | null {
    return this.taskOps.getLatestTaskRun(taskId);
  }

  listTaskRuns(taskId: string): TaskRun[] {
    return this.taskOps.listTaskRuns(taskId);
  }

  updateTaskRun(id: string, updates: Partial<Omit<TaskRun, "id" | "taskId">>, now = Date.now()): TaskRun {
    return this.taskOps.updateTaskRun(id, updates, now);
  }

  markPromptInjected(taskId: string, now = Date.now()): boolean {
    return this.taskOps.markPromptInjected(taskId, now);
  }

  deleteTask(id: string): void {
    this.taskOps.deleteTask(id);
  }

  purgeArchivedCompletedTasksBatch(
    archivedBeforeMs: number,
    options?: { limit?: number },
  ): { taskIds: string[]; attachments: Array<{ id: string; storageKey: string }> } {
    return this.taskOps.purgeArchivedCompletedTasksBatch(archivedBeforeMs, options);
  }

  claimNextPendingTask(now = Date.now()): Task | null {
    return this.taskOps.claimNextPendingTask(now);
  }

  movePendingTask(taskId: string, direction: "up" | "down"): Task[] | null {
    return this.taskOps.movePendingTask(taskId, direction);
  }

  reorderPendingTasks(taskIds: string[]): Task[] {
    return this.taskOps.reorderPendingTasks(taskIds);
  }

  addMessage(message: Omit<TaskMessage, "id">): TaskMessage {
    return this.messageOps.addMessage(message);
  }

  getMessages(taskId: string, options?: { limit?: number }): TaskMessage[] {
    return this.messageOps.getMessages(taskId, options);
  }

  saveContext(
    taskId: string,
    context: { contextType: string; content: string; createdAt?: number },
    now = Date.now(),
  ): TaskContext {
    return this.messageOps.saveContext(taskId, context, now);
  }

  getContext(taskId: string): TaskContext[] {
    return this.messageOps.getContext(taskId);
  }

  listModelConfigs(): ModelConfig[] {
    return this.modelConfigOps.listModelConfigs();
  }

  getModelConfig(modelId: string): ModelConfig | null {
    return this.modelConfigOps.getModelConfig(modelId);
  }

  upsertModelConfig(config: ModelConfig, now = Date.now()): ModelConfig {
    return this.modelConfigOps.upsertModelConfig(config, now);
  }

  deleteModelConfig(modelId: string): boolean {
    return this.modelConfigOps.deleteModelConfig(modelId);
  }

  upsertConversation(
    conversation: Partial<Omit<Conversation, "id">> & Pick<Conversation, "id">,
    now = Date.now(),
  ): Conversation {
    return this.conversationOps.upsertConversation(conversation, now);
  }

  getConversation(conversationId: string): Conversation | null {
    return this.conversationOps.getConversation(conversationId);
  }

  addConversationMessage(message: Omit<ConversationMessage, "id">, now = Date.now()): ConversationMessage {
    return this.conversationOps.addConversationMessage(message, now);
  }

  getConversationMessages(conversationId: string, options?: { limit?: number }): ConversationMessage[] {
    return this.conversationOps.getConversationMessages(conversationId, options);
  }
}

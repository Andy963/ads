import crypto from "node:crypto";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";

import type {
  CreateTaskInput,
  Conversation,
  ConversationMessage,
  ConversationStatus,
  ModelConfig,
  PlanStep,
  PlanStepInput,
  PlanStepStatus,
  Task,
  TaskContext,
  TaskFilter,
  TaskMessage,
  TaskRole,
  TaskStatus,
} from "./types.js";

type SqliteStatement = StatementType<unknown[], unknown>;

function parseJson<T>(raw: unknown): T | null {
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

function normalizeTaskStatus(value: unknown): TaskStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
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

function normalizePlanStepStatus(value: unknown): PlanStepStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "pending":
    case "running":
    case "completed":
    case "skipped":
    case "failed":
      return raw;
    default:
      return "pending";
  }
}

function normalizeRole(value: unknown): TaskRole {
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

function normalizeConversationStatus(value: unknown): ConversationStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "active":
    case "archived":
      return raw;
    default:
      return "active";
  }
}

export class TaskStore {
  private readonly db: DatabaseType;

  private readonly insertTaskStmt: SqliteStatement;
  private readonly getTaskStmt: SqliteStatement;
  private readonly listTasksStmt: SqliteStatement;
  private readonly listTasksByStatusStmt: SqliteStatement;
  private readonly updateTaskStmt: SqliteStatement;
  private readonly deleteTaskStmt: SqliteStatement;

  private readonly selectNextPendingStmt: SqliteStatement;
  private readonly claimTaskStmt: SqliteStatement;

  private readonly deletePlanStmt: SqliteStatement;
  private readonly insertPlanStepStmt: SqliteStatement;
  private readonly getPlanStmt: SqliteStatement;
  private readonly updatePlanStepStatusStmt: SqliteStatement;
  private readonly getPlanStepIdStmt: SqliteStatement;

  private readonly insertMessageStmt: SqliteStatement;
  private readonly getMessagesStmt: SqliteStatement;
  private readonly getMessagesLimitedStmt: SqliteStatement;

  private readonly insertContextStmt: SqliteStatement;
  private readonly getContextsStmt: SqliteStatement;

  private readonly listModelConfigsStmt: SqliteStatement;

  private readonly upsertConversationStmt: SqliteStatement;
  private readonly getConversationStmt: SqliteStatement;
  private readonly insertConversationMessageStmt: SqliteStatement;
  private readonly getConversationMessagesStmt: SqliteStatement;
  private readonly getConversationMessagesLimitedStmt: SqliteStatement;

  private readonly selectMostRecentThreadIdStmt: SqliteStatement;

  constructor(options?: { workspacePath?: string }) {
    this.db = getDatabase(options?.workspacePath);

    this.insertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (
        id,
        title,
        prompt,
        model,
        model_params,
        status,
        priority,
        inherit_context,
        parent_task_id,
        thread_id,
        result,
        error,
        retry_count,
        max_retries,
        created_at,
        started_at,
        completed_at,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getTaskStmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ? LIMIT 1`);

    this.listTasksStmt = this.db.prepare(
      `SELECT * FROM tasks ORDER BY priority DESC, created_at DESC LIMIT ?`,
    );
    this.listTasksByStatusStmt = this.db.prepare(
      `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ?`,
    );

    this.updateTaskStmt = this.db.prepare(`
      UPDATE tasks
      SET
        title = ?,
        prompt = ?,
        model = ?,
        model_params = ?,
        status = ?,
        priority = ?,
        inherit_context = ?,
        parent_task_id = ?,
        thread_id = ?,
        result = ?,
        error = ?,
        retry_count = ?,
        max_retries = ?,
        created_at = ?,
        started_at = ?,
        completed_at = ?,
        created_by = ?
      WHERE id = ?
    `);

    this.deleteTaskStmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);

    this.selectNextPendingStmt = this.db.prepare(
      `SELECT id FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1`,
    );
    this.claimTaskStmt = this.db.prepare(
      `UPDATE tasks SET status = 'planning', started_at = COALESCE(started_at, ?)
       WHERE id = ? AND status = 'pending'`,
    );

    this.deletePlanStmt = this.db.prepare(`DELETE FROM task_plans WHERE task_id = ?`);
    this.insertPlanStepStmt = this.db.prepare(
      `INSERT INTO task_plans (task_id, step_number, title, description, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getPlanStmt = this.db.prepare(
      `SELECT * FROM task_plans WHERE task_id = ? ORDER BY step_number ASC`,
    );

    this.getPlanStepIdStmt = this.db.prepare(
      `SELECT id FROM task_plans WHERE task_id = ? AND step_number = ? LIMIT 1`,
    );
    this.updatePlanStepStatusStmt = this.db.prepare(
      `UPDATE task_plans
       SET status = ?, started_at = ?, completed_at = ?
       WHERE task_id = ? AND step_number = ?`,
    );

    this.insertMessageStmt = this.db.prepare(
      `INSERT INTO task_messages (
        task_id, plan_step_id, role, content, message_type, model_used, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.getMessagesStmt = this.db.prepare(
      `SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC`,
    );
    this.getMessagesLimitedStmt = this.db.prepare(
      `SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
    );

    this.insertContextStmt = this.db.prepare(
      `INSERT INTO task_contexts (task_id, context_type, content, created_at) VALUES (?, ?, ?, ?)`,
    );
    this.getContextsStmt = this.db.prepare(
      `SELECT * FROM task_contexts WHERE task_id = ? ORDER BY created_at ASC`,
    );

    this.listModelConfigsStmt = this.db.prepare(
      `SELECT * FROM model_configs ORDER BY is_default DESC, display_name ASC`,
    );

    this.upsertConversationStmt = this.db.prepare(`
      INSERT INTO conversations (
        id,
        task_id,
        title,
        total_tokens,
        last_model,
        model_response_ids,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        title = excluded.title,
        total_tokens = excluded.total_tokens,
        last_model = excluded.last_model,
        model_response_ids = excluded.model_response_ids,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    this.getConversationStmt = this.db.prepare(`SELECT * FROM conversations WHERE id = ? LIMIT 1`);
    this.insertConversationMessageStmt = this.db.prepare(`
      INSERT INTO conversation_messages (
        conversation_id,
        task_id,
        role,
        content,
        model_id,
        token_count,
        metadata,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getConversationMessagesStmt = this.db.prepare(
      `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    );
    this.getConversationMessagesLimitedStmt = this.db.prepare(
      `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    );

    this.selectMostRecentThreadIdStmt = this.db.prepare(
      `SELECT thread_id FROM tasks
       WHERE thread_id IS NOT NULL AND TRIM(thread_id) != ''
       ORDER BY COALESCE(completed_at, 0) DESC, created_at DESC
       LIMIT 1`,
    );
  }

  createTask(input: CreateTaskInput, now = Date.now()): Task {
    const id = (input.id ?? crypto.randomUUID()).trim();
    const rawTitle = String(input.title ?? "").trim();
    const prompt = String(input.prompt ?? "");
    if (!prompt.trim()) {
      throw new Error("Task prompt is required");
    }
    const title = rawTitle || (() => {
      const firstLine = prompt
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      const base = (firstLine ?? "新任务").replace(/\s+/g, " ");
      const maxLen = 32;
      if (base.length <= maxLen) return base;
      return `${base.slice(0, maxLen)}…`;
    })();

    const task: Task = {
      id,
      title,
      prompt,
      model: (input.model ?? "auto").trim() || "auto",
      modelParams: input.modelParams ?? null,
      status: "pending",
      priority: typeof input.priority === "number" ? input.priority : 0,
      inheritContext: Boolean(input.inheritContext),
      parentTaskId: input.parentTaskId ?? null,
      threadId: (() => {
        const provided = input.threadId == null ? "" : String(input.threadId).trim();
        if (provided) {
          return provided;
        }
        if (Boolean(input.inheritContext)) {
          const row = this.selectMostRecentThreadIdStmt.get() as { thread_id?: string } | undefined;
          const inherited = row?.thread_id == null ? "" : String(row.thread_id).trim();
          if (inherited) {
            return inherited;
          }
        }
        return `conv-${id}`;
      })(),
      result: null,
      error: null,
      retryCount: 0,
      maxRetries: typeof input.maxRetries === "number" ? Math.max(0, Math.floor(input.maxRetries)) : 3,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      createdBy: input.createdBy ?? null,
    };

    this.insertTaskStmt.run(
      task.id,
      task.title,
      task.prompt,
      task.model,
      task.modelParams ? JSON.stringify(task.modelParams) : null,
      task.status,
      task.priority,
      task.inheritContext ? 1 : 0,
      task.parentTaskId ?? null,
      task.threadId ?? null,
      task.result ?? null,
      task.error ?? null,
      task.retryCount,
      task.maxRetries,
      task.createdAt,
      task.startedAt ?? null,
      task.completedAt ?? null,
      task.createdBy ?? null,
    );

    return task;
  }

  getTask(id: string): Task | null {
    const normalized = String(id ?? "").trim();
    if (!normalized) {
      return null;
    }
    const row = this.getTaskStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? this.toTask(row) : null;
  }

  listTasks(filter?: TaskFilter): Task[] {
    const limit =
      typeof filter?.limit === "number" && Number.isFinite(filter.limit) && filter.limit > 0
        ? Math.floor(filter.limit)
        : 50;
    const rows = (
      filter?.status
        ? this.listTasksByStatusStmt.all(filter.status, limit)
        : this.listTasksStmt.all(limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.toTask(row));
  }

  updateTask(id: string, updates: Partial<Omit<Task, "id">>, now = Date.now()): Task {
    const existing = this.getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const merged: Task = {
      ...existing,
      ...updates,
      id: existing.id,
    };

    // Normalize booleans & status
    merged.status = normalizeTaskStatus(merged.status);
    merged.inheritContext = Boolean(merged.inheritContext);
    merged.priority = Number.isFinite(merged.priority) ? merged.priority : existing.priority;
    merged.retryCount = Number.isFinite(merged.retryCount) ? merged.retryCount : existing.retryCount;
    merged.maxRetries = Number.isFinite(merged.maxRetries) ? merged.maxRetries : existing.maxRetries;

    // Auto timestamps
    if (merged.status === "running" && !merged.startedAt) {
      merged.startedAt = existing.startedAt ?? now;
    }
    if (["completed", "failed", "cancelled"].includes(merged.status) && !merged.completedAt) {
      merged.completedAt = now;
    }

    this.updateTaskStmt.run(
      merged.title,
      merged.prompt,
      merged.model,
      merged.modelParams ? JSON.stringify(merged.modelParams) : null,
      merged.status,
      merged.priority,
      merged.inheritContext ? 1 : 0,
      merged.parentTaskId ?? null,
      merged.threadId ?? null,
      merged.result ?? null,
      merged.error ?? null,
      merged.retryCount,
      merged.maxRetries,
      merged.createdAt,
      merged.startedAt ?? null,
      merged.completedAt ?? null,
      merged.createdBy ?? null,
      merged.id,
    );

    return merged;
  }

  deleteTask(id: string): void {
    const normalized = String(id ?? "").trim();
    if (!normalized) {
      return;
    }
    this.deleteTaskStmt.run(normalized);
  }

  /**
   * Atomically claims the next pending task by setting it to planning.
   * Returns the claimed task, or null if none available.
   */
  claimNextPendingTask(now = Date.now()): Task | null {
    const tx = this.db.transaction((): Task | null => {
      const next = this.selectNextPendingStmt.get() as { id?: string } | undefined;
      const id = String(next?.id ?? "").trim();
      if (!id) {
        return null;
      }
      const updated = this.claimTaskStmt.run(now, id) as { changes?: number };
      if (!updated || updated.changes !== 1) {
        return null;
      }
      const claimed = this.getTask(id);
      return claimed;
    });

    return tx();
  }

  getPlan(taskId: string): PlanStep[] {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return [];
    }
    const rows = this.getPlanStmt.all(id) as Record<string, unknown>[];
    return rows.map((row) => this.toPlanStep(row));
  }

  setPlan(taskId: string, steps: PlanStepInput[]): PlanStep[] {
    const id = String(taskId ?? "").trim();
    if (!id) {
      throw new Error("taskId is required");
    }
    const normalizedSteps = steps
      .map((step) => ({
        stepNumber: Math.max(1, Math.floor(step.stepNumber)),
        title: String(step.title ?? "").trim(),
        description: step.description == null ? null : String(step.description),
      }))
      .filter((step) => step.title);

    const tx = this.db.transaction(() => {
      this.deletePlanStmt.run(id);
      for (const step of normalizedSteps) {
        this.insertPlanStepStmt.run(
          id,
          step.stepNumber,
          step.title,
          step.description,
          "pending",
          null,
          null,
        );
      }
    });
    tx();

    const plan = this.getPlan(id);
    if (plan.length === 0) {
      // Ensure at least one step so execution can proceed.
      this.insertPlanStepStmt.run(id, 1, "执行任务", null, "pending", null, null);
      return this.getPlan(id);
    }
    return plan;
  }

  updatePlanStep(taskId: string, stepNumber: number, status: PlanStepStatus, now = Date.now()): void {
    const id = String(taskId ?? "").trim();
    const step = Math.max(1, Math.floor(stepNumber));
    const normalizedStatus = normalizePlanStepStatus(status);

    const existing = this.getPlanStepIdStmt.get(id, step) as { id?: number; started_at?: number | null; completed_at?: number | null; status?: string } | undefined;
    const priorStarted = existing?.started_at ?? null;
    const startedAt = (() => {
      if (normalizedStatus === "pending") {
        return null;
      }
      if (normalizedStatus === "running") {
        return priorStarted ?? now;
      }
      return priorStarted ?? now;
    })();

    const completedAt = (() => {
      if (normalizedStatus === "pending" || normalizedStatus === "running") {
        return null;
      }
      return now;
    })();

    this.updatePlanStepStatusStmt.run(normalizedStatus, startedAt, completedAt, id, step);
  }

  getPlanStepId(taskId: string, stepNumber: number): number | null {
    const id = String(taskId ?? "").trim();
    const step = Math.max(1, Math.floor(stepNumber));
    const row = this.getPlanStepIdStmt.get(id, step) as { id?: number } | undefined;
    return typeof row?.id === "number" ? row.id : null;
  }

  addMessage(message: Omit<TaskMessage, "id">): TaskMessage {
    const taskId = String(message.taskId ?? "").trim();
    if (!taskId) {
      throw new Error("taskId is required");
    }
    const createdAt = typeof message.createdAt === "number" ? message.createdAt : Date.now();
    const rowRole = normalizeRole(message.role);
    const content = String(message.content ?? "");
    if (!content.trim()) {
      throw new Error("message content is required");
    }
    this.insertMessageStmt.run(
      taskId,
      message.planStepId ?? null,
      rowRole,
      content,
      message.messageType ?? null,
      message.modelUsed ?? null,
      message.tokenCount ?? null,
      createdAt,
    );
    return { ...message, role: rowRole, createdAt };
  }

  getMessages(taskId: string, options?: { limit?: number }): TaskMessage[] {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return [];
    }
    const limit = options?.limit;
    const rows =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? (this.getMessagesLimitedStmt.all(id, Math.floor(limit)) as Record<string, unknown>[])
        : (this.getMessagesStmt.all(id) as Record<string, unknown>[]);

    const mapped = rows.map((row) => this.toTaskMessage(row));
    // Limited query returns desc order.
    return typeof limit === "number" && limit > 0 ? mapped.reverse() : mapped;
  }

  saveContext(
    taskId: string,
    context: { contextType: string; content: string; createdAt?: number },
    now = Date.now(),
  ): TaskContext {
    const id = String(taskId ?? "").trim();
    if (!id) {
      throw new Error("taskId is required");
    }
    const contextType = String(context.contextType ?? "").trim();
    if (!contextType) {
      throw new Error("contextType is required");
    }
    const content = String(context.content ?? "");
    if (!content.trim()) {
      throw new Error("context content is required");
    }
    const createdAt = typeof context.createdAt === "number" ? context.createdAt : now;
    this.insertContextStmt.run(id, contextType, content, createdAt);
    return { taskId: id, contextType, content, createdAt };
  }

  getContext(taskId: string): TaskContext[] {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return [];
    }
    const rows = this.getContextsStmt.all(id) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
      taskId: String(row.task_id ?? ""),
      contextType: String(row.context_type ?? ""),
      content: String(row.content ?? ""),
      createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
    }));
  }

  listModelConfigs(): ModelConfig[] {
    const rows = this.listModelConfigsStmt.all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      displayName: String(row.display_name ?? ""),
      provider: String(row.provider ?? ""),
      isEnabled: Boolean(row.is_enabled),
      isDefault: Boolean(row.is_default),
      configJson: parseJson<Record<string, unknown>>(row.config_json) ?? null,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : row.updated_at == null ? null : Number(row.updated_at),
    }));
  }

  upsertConversation(
    conversation: Partial<Omit<Conversation, "id">> & Pick<Conversation, "id">,
    now = Date.now(),
  ): Conversation {
    const id = String(conversation.id ?? "").trim();
    if (!id) {
      throw new Error("conversation id is required");
    }
    const existing = this.getConversation(id);
    const createdAt = existing?.createdAt ?? (typeof conversation.createdAt === "number" ? conversation.createdAt : now);
    const updatedAt = typeof conversation.updatedAt === "number" ? conversation.updatedAt : now;
    const modelResponseIds =
      conversation.modelResponseIds === undefined
        ? existing?.modelResponseIds ?? null
        : conversation.modelResponseIds ?? null;

    const merged: Conversation = {
      id,
      taskId: conversation.taskId === undefined ? existing?.taskId ?? null : conversation.taskId ?? null,
      title: conversation.title === undefined ? existing?.title ?? null : conversation.title ?? null,
      totalTokens:
        conversation.totalTokens === undefined
          ? existing?.totalTokens ?? 0
          : Number.isFinite(conversation.totalTokens)
            ? Math.max(0, Math.floor(conversation.totalTokens))
            : 0,
      lastModel: conversation.lastModel === undefined ? existing?.lastModel ?? null : conversation.lastModel ?? null,
      modelResponseIds,
      status: normalizeConversationStatus(conversation.status ?? existing?.status ?? "active"),
      createdAt,
      updatedAt,
    };

    this.upsertConversationStmt.run(
      merged.id,
      merged.taskId ?? null,
      merged.title ?? null,
      merged.totalTokens,
      merged.lastModel ?? null,
      merged.modelResponseIds ? JSON.stringify(merged.modelResponseIds) : null,
      merged.status,
      merged.createdAt,
      merged.updatedAt,
    );

    return merged;
  }

  getConversation(conversationId: string): Conversation | null {
    const id = String(conversationId ?? "").trim();
    if (!id) {
      return null;
    }
    const row = this.getConversationStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.id ?? ""),
      taskId: row.task_id == null ? null : String(row.task_id),
      title: row.title == null ? null : String(row.title),
      totalTokens: typeof row.total_tokens === "number" ? row.total_tokens : Number(row.total_tokens ?? 0),
      lastModel: row.last_model == null ? null : String(row.last_model),
      modelResponseIds: parseJson<Record<string, string>>(row.model_response_ids) ?? null,
      status: normalizeConversationStatus(row.status),
      createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at ?? 0),
    };
  }

  addConversationMessage(message: Omit<ConversationMessage, "id">, now = Date.now()): ConversationMessage {
    const conversationId = String(message.conversationId ?? "").trim();
    if (!conversationId) {
      throw new Error("conversationId is required");
    }
    // Ensure the conversation exists for the FK constraint.
    this.upsertConversation({ id: conversationId }, now);
    const createdAt = typeof message.createdAt === "number" ? message.createdAt : now;
    const rowRole = normalizeRole(message.role);
    const content = String(message.content ?? "");
    if (!content.trim()) {
      throw new Error("message content is required");
    }
    this.insertConversationMessageStmt.run(
      conversationId,
      message.taskId ?? null,
      rowRole,
      content,
      message.modelId ?? null,
      message.tokenCount ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      createdAt,
    );
    this.upsertConversation({ id: conversationId, updatedAt: createdAt }, createdAt);
    return { ...message, role: rowRole, content, createdAt };
  }

  getConversationMessages(conversationId: string, options?: { limit?: number }): ConversationMessage[] {
    const id = String(conversationId ?? "").trim();
    if (!id) {
      return [];
    }
    const limit = options?.limit;
    const rows =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? (this.getConversationMessagesLimitedStmt.all(id, Math.floor(limit)) as Record<string, unknown>[])
        : (this.getConversationMessagesStmt.all(id) as Record<string, unknown>[]);

    const mapped = rows.map((row) => ({
      id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
      conversationId: String(row.conversation_id ?? ""),
      taskId: row.task_id == null ? null : String(row.task_id),
      role: normalizeRole(row.role),
      content: String(row.content ?? ""),
      modelId: row.model_id == null ? null : String(row.model_id),
      tokenCount: row.token_count == null ? null : (typeof row.token_count === "number" ? row.token_count : Number(row.token_count)),
      metadata: parseJson<Record<string, unknown>>(row.metadata) ?? null,
      createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
    }));
    return typeof limit === "number" && limit > 0 ? mapped.reverse() : mapped;
  }

  private toTask(row: Record<string, unknown>): Task {
    return {
      id: String(row.id ?? ""),
      title: String(row.title ?? ""),
      prompt: String(row.prompt ?? ""),
      model: String(row.model ?? "auto"),
      modelParams: parseJson<Record<string, unknown>>(row.model_params),
      status: normalizeTaskStatus(row.status),
      priority: typeof row.priority === "number" ? row.priority : Number(row.priority ?? 0),
      inheritContext: Boolean(row.inherit_context),
      parentTaskId: row.parent_task_id == null ? null : String(row.parent_task_id),
      threadId: row.thread_id == null ? null : String(row.thread_id),
      result: row.result == null ? null : String(row.result),
      error: row.error == null ? null : String(row.error),
      retryCount: typeof row.retry_count === "number" ? row.retry_count : Number(row.retry_count ?? 0),
      maxRetries: typeof row.max_retries === "number" ? row.max_retries : Number(row.max_retries ?? 3),
      createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
      startedAt: row.started_at == null ? null : (typeof row.started_at === "number" ? row.started_at : Number(row.started_at)),
      completedAt: row.completed_at == null ? null : (typeof row.completed_at === "number" ? row.completed_at : Number(row.completed_at)),
      createdBy: row.created_by == null ? null : String(row.created_by),
    };
  }

  private toPlanStep(row: Record<string, unknown>): PlanStep {
    return {
      id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
      taskId: String(row.task_id ?? ""),
      stepNumber: typeof row.step_number === "number" ? row.step_number : Number(row.step_number ?? 0),
      title: String(row.title ?? ""),
      description: row.description == null ? null : String(row.description),
      status: normalizePlanStepStatus(row.status),
      startedAt: row.started_at == null ? null : (typeof row.started_at === "number" ? row.started_at : Number(row.started_at)),
      completedAt: row.completed_at == null ? null : (typeof row.completed_at === "number" ? row.completed_at : Number(row.completed_at)),
    };
  }

  private toTaskMessage(row: Record<string, unknown>): TaskMessage {
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
}

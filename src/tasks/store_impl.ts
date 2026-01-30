import crypto from "node:crypto";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";
import { prepareTaskStoreStatements } from "./storeStatements.js";

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

  private readonly markPromptInjectedStmt: SqliteStatement;

  private readonly selectNextQueueOrderStmt: SqliteStatement;
  private readonly selectActiveTaskIdStmt: SqliteStatement;

  private readonly selectNextQueuedStmt: SqliteStatement;
  private readonly promoteQueuedToPendingStmt: SqliteStatement;

  private readonly selectNextPendingStmt: SqliteStatement;
  private readonly claimTaskStmt: SqliteStatement;

  private readonly listPendingForReorderStmt: SqliteStatement;
  private readonly updateQueueOrderStmt: SqliteStatement;

  private readonly deletePlanStmt: SqliteStatement;
  private readonly clearPlanStepRefsStmt: SqliteStatement;
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
  private readonly getModelConfigStmt: SqliteStatement;
  private readonly clearDefaultModelConfigsStmt: SqliteStatement;
  private readonly upsertModelConfigStmt: SqliteStatement;
  private readonly deleteModelConfigStmt: SqliteStatement;

  private readonly upsertConversationStmt: SqliteStatement;
  private readonly getConversationStmt: SqliteStatement;
  private readonly insertConversationMessageStmt: SqliteStatement;
  private readonly getConversationMessagesStmt: SqliteStatement;
  private readonly getConversationMessagesLimitedStmt: SqliteStatement;

  private readonly selectMostRecentThreadIdStmt: SqliteStatement;

  constructor(options?: { workspacePath?: string }) {
    this.db = getDatabase(options?.workspacePath);

    const stmts = prepareTaskStoreStatements(this.db);
    this.insertTaskStmt = stmts.insertTaskStmt;
    this.getTaskStmt = stmts.getTaskStmt;
    this.listTasksStmt = stmts.listTasksStmt;
    this.listTasksByStatusStmt = stmts.listTasksByStatusStmt;
    this.updateTaskStmt = stmts.updateTaskStmt;
    this.deleteTaskStmt = stmts.deleteTaskStmt;
    this.markPromptInjectedStmt = stmts.markPromptInjectedStmt;
    this.selectNextQueueOrderStmt = stmts.selectNextQueueOrderStmt;
    this.selectActiveTaskIdStmt = stmts.selectActiveTaskIdStmt;
    this.selectNextQueuedStmt = stmts.selectNextQueuedStmt;
    this.promoteQueuedToPendingStmt = stmts.promoteQueuedToPendingStmt;
    this.selectNextPendingStmt = stmts.selectNextPendingStmt;
    this.claimTaskStmt = stmts.claimTaskStmt;
    this.listPendingForReorderStmt = stmts.listPendingForReorderStmt;
    this.updateQueueOrderStmt = stmts.updateQueueOrderStmt;
    this.deletePlanStmt = stmts.deletePlanStmt;
    this.clearPlanStepRefsStmt = stmts.clearPlanStepRefsStmt;
    this.insertPlanStepStmt = stmts.insertPlanStepStmt;
    this.getPlanStmt = stmts.getPlanStmt;
    this.updatePlanStepStatusStmt = stmts.updatePlanStepStatusStmt;
    this.getPlanStepIdStmt = stmts.getPlanStepIdStmt;
    this.insertMessageStmt = stmts.insertMessageStmt;
    this.getMessagesStmt = stmts.getMessagesStmt;
    this.getMessagesLimitedStmt = stmts.getMessagesLimitedStmt;
    this.insertContextStmt = stmts.insertContextStmt;
    this.getContextsStmt = stmts.getContextsStmt;
    this.listModelConfigsStmt = stmts.listModelConfigsStmt;
    this.getModelConfigStmt = stmts.getModelConfigStmt;
    this.clearDefaultModelConfigsStmt = stmts.clearDefaultModelConfigsStmt;
    this.upsertModelConfigStmt = stmts.upsertModelConfigStmt;
    this.deleteModelConfigStmt = stmts.deleteModelConfigStmt;
    this.upsertConversationStmt = stmts.upsertConversationStmt;
    this.getConversationStmt = stmts.getConversationStmt;
    this.insertConversationMessageStmt = stmts.insertConversationMessageStmt;
    this.getConversationMessagesStmt = stmts.getConversationMessagesStmt;
    this.getConversationMessagesLimitedStmt = stmts.getConversationMessagesLimitedStmt;
    this.selectMostRecentThreadIdStmt = stmts.selectMostRecentThreadIdStmt;
  }

  createTask(
    input: CreateTaskInput,
    now = Date.now(),
    options?: { status?: TaskStatus; queuedAt?: number | null },
  ): Task {
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

    const inheritContext = Boolean(input.inheritContext);

    const queueOrderRow = this.selectNextQueueOrderStmt.get() as { next?: number } | undefined;
    const nextQueueOrder =
      typeof queueOrderRow?.next === "number" && Number.isFinite(queueOrderRow.next) ? queueOrderRow.next : now;

    const status = normalizeTaskStatus(options?.status ?? "pending");
    const queuedAt =
      options?.queuedAt != null && Number.isFinite(options.queuedAt)
        ? options.queuedAt
        : status === "queued"
          ? now
          : null;

    const task: Task = {
      id,
      title,
      prompt,
      model: (input.model ?? "auto").trim() || "auto",
      modelParams: input.modelParams ?? null,
      status,
      priority: typeof input.priority === "number" ? input.priority : 0,
      queueOrder: nextQueueOrder,
      queuedAt,
      promptInjectedAt: null,
      inheritContext,
      parentTaskId: input.parentTaskId ?? null,
      threadId: (() => {
        const provided = input.threadId == null ? "" : String(input.threadId).trim();
        if (provided) {
          return provided;
        }
        if (inheritContext) {
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
      task.queueOrder,
      task.queuedAt ?? null,
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

  getActiveTaskId(): string | null {
    const row = this.selectActiveTaskIdStmt.get() as { id?: string } | undefined;
    const id = String(row?.id ?? "").trim();
    return id || null;
  }

  dequeueNextQueuedTask(now = Date.now()): Task | null {
    void now;
    const tx = this.db.transaction((): Task | null => {
      const next = this.selectNextQueuedStmt.get() as { id?: string } | undefined;
      const id = String(next?.id ?? "").trim();
      if (!id) {
        return null;
      }
      const updated = this.promoteQueuedToPendingStmt.run(id) as { changes?: number };
      if (!updated || updated.changes !== 1) {
        return null;
      }
      return this.getTask(id);
    });

    return tx();
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
      // promptInjectedAt is a write-once field controlled by markPromptInjected().
      merged.promptInjectedAt = existing.promptInjectedAt ?? null;
	    merged.priority = Number.isFinite(merged.priority) ? merged.priority : existing.priority;
	    merged.queueOrder = Number.isFinite(merged.queueOrder) ? merged.queueOrder : existing.queueOrder;
	    merged.queuedAt =
	      merged.queuedAt != null && Number.isFinite(merged.queuedAt)
	        ? merged.queuedAt
	        : (existing.queuedAt ?? null);
	    merged.retryCount = Number.isFinite(merged.retryCount) ? merged.retryCount : existing.retryCount;
	    merged.maxRetries = Number.isFinite(merged.maxRetries) ? merged.maxRetries : existing.maxRetries;

	    // Auto timestamps
	    if (merged.status === "queued" && !merged.queuedAt) {
	      merged.queuedAt = now;
	    }
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
	      merged.queueOrder,
	      merged.queuedAt ?? null,
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

  markPromptInjected(taskId: string, now = Date.now()): boolean {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return false;
    }
    const updated = this.markPromptInjectedStmt.run(now, id) as { changes?: number };
    return Boolean(updated && updated.changes === 1);
  }

  deleteTask(id: string): void {
    const normalized = String(id ?? "").trim();
    if (!normalized) {
      return;
    }
    this.deleteTaskStmt.run(normalized);
  }

  /**
   * Atomically claims the next pending task by setting it to running.
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

  movePendingTask(taskId: string, direction: "up" | "down"): Task[] | null {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return null;
    }

    const rows = this.listPendingForReorderStmt.all() as Array<{
      id?: string;
      queue_order?: number;
    }>;
    const ids = rows.map((r) => String(r.id ?? "").trim()).filter(Boolean);
    const idx = ids.indexOf(id);
    if (idx < 0) {
      return null;
    }

    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= ids.length) {
      return null;
    }

    const aId = id;
    const bId = ids[neighborIdx]!;

    const aRow = rows[idx] ?? {};
    const bRow = rows[neighborIdx] ?? {};
    const aOrder = typeof aRow.queue_order === "number" && Number.isFinite(aRow.queue_order) ? aRow.queue_order : idx;
    const bOrder = typeof bRow.queue_order === "number" && Number.isFinite(bRow.queue_order) ? bRow.queue_order : neighborIdx;

    const tx = this.db.transaction(() => {
      if (aOrder === bOrder) {
        const nextA = direction === "up" ? bOrder - 1 : bOrder + 1;
        this.updateQueueOrderStmt.run(nextA, aId);
        this.updateQueueOrderStmt.run(bOrder, bId);
      } else {
        this.updateQueueOrderStmt.run(bOrder, aId);
        this.updateQueueOrderStmt.run(aOrder, bId);
      }
    });
    tx();

    const a = this.getTask(aId);
    const b = this.getTask(bId);
    if (!a || !b) {
      return null;
    }
    return [a, b];
  }

  reorderPendingTasks(taskIds: string[]): Task[] {
    const normalized = (taskIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
    if (normalized.length === 0) {
      throw new Error("taskIds is required");
    }
    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
      throw new Error("taskIds must be unique");
    }

    const rows = this.listPendingForReorderStmt.all() as Array<{ id?: string; queue_order?: number; created_at?: number }>;
    const current = rows.map((r) => String(r.id ?? "").trim()).filter(Boolean);
    const currentSet = new Set(current);
    const pendingIds = normalized.filter((id) => currentSet.has(id));
    if (pendingIds.length === 0) {
      // Nothing to reorder (all ids already left pending state).
      return current.map((id) => this.getTask(id)).filter((t): t is Task => Boolean(t));
    }
    for (const id of pendingIds) {
      if (!currentSet.has(id)) {
        throw new Error(`task is not pending: ${id}`);
      }
    }

    const nextIds = (() => {
      // Fast-path: client provided the full pending order.
      if (pendingIds.length === current.length) {
        return pendingIds;
      }

      // Partial reorder: only permute the provided ids within the current pending sequence.
      // This keeps all other pending tasks in place and avoids requiring the client to know
      // about all pending tasks (e.g., when the UI only loads a subset).
      const selected = new Set(pendingIds);
      const merged: string[] = new Array(current.length);
      let cursor = 0;
      for (let i = 0; i < current.length; i++) {
        const id = current[i]!;
        if (!selected.has(id)) {
          merged[i] = id;
          continue;
        }
        merged[i] = pendingIds[cursor]!;
        cursor += 1;
      }
      if (cursor !== pendingIds.length) {
        throw new Error("taskIds mismatch");
      }
      return merged;
    })();

    const base = (() => {
      // Keep queue_order in a compact monotonic range so the ordering is stable and predictable.
      // For older databases where queue_order can be NULL, fall back to 0.
      let min = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        if (typeof row.queue_order === "number" && Number.isFinite(row.queue_order)) {
          min = Math.min(min, row.queue_order);
        }
      }
      return Number.isFinite(min) ? Math.floor(min) : 0;
    })();

    const tx = this.db.transaction(() => {
      for (let i = 0; i < nextIds.length; i++) {
        this.updateQueueOrderStmt.run(base + i, nextIds[i]);
      }
    });
    tx();

    // Return the full pending order after update so clients can refresh their local state even
    // when they only provided a partial id list.
    const afterRows = this.listPendingForReorderStmt.all() as Array<{ id?: string }>;
    const updated: Task[] = [];
    for (const row of afterRows) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;
      const task = this.getTask(id);
      if (task) updated.push(task);
    }
    return updated;
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
      // Replanning deletes task_plans rows. Null out references first so old messages remain valid.
      this.clearPlanStepRefsStmt.run(id);
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

  getModelConfig(modelId: string): ModelConfig | null {
    const id = String(modelId ?? "").trim();
    if (!id) {
      return null;
    }
    const row = this.getModelConfigStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.id ?? ""),
      displayName: String(row.display_name ?? ""),
      provider: String(row.provider ?? ""),
      isEnabled: Boolean(row.is_enabled),
      isDefault: Boolean(row.is_default),
      configJson: parseJson<Record<string, unknown>>(row.config_json) ?? null,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : row.updated_at == null ? null : Number(row.updated_at),
    };
  }

  upsertModelConfig(config: ModelConfig, now = Date.now()): ModelConfig {
    const id = String(config.id ?? "").trim();
    if (!id) {
      throw new Error("model config id is required");
    }
    const displayName = String(config.displayName ?? "").trim();
    if (!displayName) {
      throw new Error("model config displayName is required");
    }
    const provider = String(config.provider ?? "").trim();
    if (!provider) {
      throw new Error("model config provider is required");
    }

    const isEnabled = Boolean(config.isEnabled);
    const isDefault = Boolean(config.isDefault);
    const configJson = config.configJson ?? null;
    const configJsonText = configJson ? JSON.stringify(configJson) : null;

    const tx = this.db.transaction(() => {
      if (isDefault) {
        this.clearDefaultModelConfigsStmt.run();
      }
      this.upsertModelConfigStmt.run(
        id,
        displayName,
        provider,
        isEnabled ? 1 : 0,
        isDefault ? 1 : 0,
        configJsonText,
        now,
      );
    });
    tx();

    const saved = this.getModelConfig(id);
    if (!saved) {
      throw new Error("failed to load saved model config");
    }
    return saved;
  }

  deleteModelConfig(modelId: string): boolean {
    const id = String(modelId ?? "").trim();
    if (!id) {
      return false;
    }
    const res = this.deleteModelConfigStmt.run(id) as { changes?: number };
    return Number(res.changes ?? 0) > 0;
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

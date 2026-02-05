import type { Database as DatabaseType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";
import { type TaskStoreStatements, prepareTaskStoreStatements } from "./storeStatements.js";
import type {
  CreateTaskInput,
  Conversation,
  ConversationMessage,
  ModelConfig,
  Task,
  TaskContext,
  TaskFilter,
  TaskMessage,
  TaskStatus,
} from "./types.js";

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
    this.db = getDatabase(options?.workspacePath);
    this.stmts = prepareTaskStoreStatements(this.db);

    this.taskOps = createTaskStoreTaskOps({ db: this.db, stmts: this.stmts });
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

  dequeueNextQueuedTask(now = Date.now()): Task | null {
    return this.taskOps.dequeueNextQueuedTask(now);
  }

  getTask(id: string): Task | null {
    return this.taskOps.getTask(id);
  }

  listTasks(filter?: TaskFilter): Task[] {
    return this.taskOps.listTasks(filter);
  }

  updateTask(id: string, updates: Partial<Omit<Task, "id">>, now = Date.now()): Task {
    return this.taskOps.updateTask(id, updates, now);
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
    const cutoffMs =
      typeof archivedBeforeMs === "number" && Number.isFinite(archivedBeforeMs) ? Math.floor(archivedBeforeMs) : 0;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : 100;

    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id
           FROM tasks
           WHERE status = 'completed' AND archived_at IS NOT NULL AND archived_at <= ?
           ORDER BY archived_at ASC, completed_at ASC, created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(cutoffMs, limit) as Array<{ id?: unknown }>;

      const taskIds = rows.map((r) => String(r?.id ?? "").trim()).filter(Boolean);
      if (taskIds.length === 0) {
        return { taskIds: [], attachments: [] as Array<{ id: string; storageKey: string }> };
      }

      const placeholders = taskIds.map(() => "?").join(", ");
      const attachments = this.db
        .prepare(`SELECT id, storage_key FROM attachments WHERE task_id IN (${placeholders})`)
        .all(...taskIds) as Array<{ id?: unknown; storage_key?: unknown }>;

      // tasks.parent_task_id uses a self-FK without ON DELETE SET NULL, so detach children first.
      this.db.prepare(`UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id IN (${placeholders})`).run(...taskIds);
      this.db.prepare(`DELETE FROM attachments WHERE task_id IN (${placeholders})`).run(...taskIds);
      this.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);

      return {
        taskIds,
        attachments: attachments
          .map((a) => ({ id: String(a.id ?? "").trim(), storageKey: String(a.storage_key ?? "").trim() }))
          .filter((a) => a.id && a.storageKey),
      };
    });

    return tx();
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

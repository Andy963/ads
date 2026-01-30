import type { TaskStoreStatements } from "../storeStatements.js";
import type { TaskContext, TaskMessage } from "../types.js";

import { toTaskMessage } from "./mappers.js";
import { normalizeRole } from "./normalize.js";

export function createTaskStoreMessageOps(deps: { stmts: TaskStoreStatements }) {
  const { stmts } = deps;

  const addMessage = (message: Omit<TaskMessage, "id">): TaskMessage => {
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
    stmts.insertMessageStmt.run(
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
  };

  const getMessages = (taskId: string, options?: { limit?: number }): TaskMessage[] => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return [];
    }
    const limit = options?.limit;
    const rows =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? (stmts.getMessagesLimitedStmt.all(id, Math.floor(limit)) as Record<string, unknown>[])
        : (stmts.getMessagesStmt.all(id) as Record<string, unknown>[]);

    const mapped = rows.map((row) => toTaskMessage(row));
    return typeof limit === "number" && limit > 0 ? mapped.reverse() : mapped;
  };

  const saveContext = (
    taskId: string,
    context: { contextType: string; content: string; createdAt?: number },
    now = Date.now(),
  ): TaskContext => {
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
    stmts.insertContextStmt.run(id, contextType, content, createdAt);
    return { taskId: id, contextType, content, createdAt };
  };

  const getContext = (taskId: string): TaskContext[] => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return [];
    }
    const rows = stmts.getContextsStmt.all(id) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: typeof row.id === "number" ? row.id : Number(row.id ?? 0),
      taskId: String(row.task_id ?? ""),
      contextType: String(row.context_type ?? ""),
      content: String(row.content ?? ""),
      createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
    }));
  };

  return { addMessage, getMessages, saveContext, getContext };
}


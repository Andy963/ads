import type { TaskStoreStatements } from "../storeStatements.js";
import type { Conversation, ConversationMessage } from "../types.js";

import { normalizeConversationStatus, normalizeRole, parseJson } from "./normalize.js";

export function createTaskStoreConversationOps(deps: { stmts: TaskStoreStatements }) {
  const { stmts } = deps;

  const getConversation = (conversationId: string): Conversation | null => {
    const id = String(conversationId ?? "").trim();
    if (!id) {
      return null;
    }
    const row = stmts.getConversationStmt.get(id) as Record<string, unknown> | undefined;
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
  };

  const upsertConversation = (
    conversation: Partial<Omit<Conversation, "id">> & Pick<Conversation, "id">,
    now = Date.now(),
  ): Conversation => {
    const id = String(conversation.id ?? "").trim();
    if (!id) {
      throw new Error("conversation id is required");
    }
    const existing = getConversation(id);
    const createdAt = existing?.createdAt ?? (typeof conversation.createdAt === "number" ? conversation.createdAt : now);
    const updatedAt = typeof conversation.updatedAt === "number" ? conversation.updatedAt : now;
    const modelResponseIds =
      conversation.modelResponseIds === undefined ? existing?.modelResponseIds ?? null : conversation.modelResponseIds ?? null;

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

    stmts.upsertConversationStmt.run(
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
  };

  const addConversationMessage = (message: Omit<ConversationMessage, "id">, now = Date.now()): ConversationMessage => {
    const conversationId = String(message.conversationId ?? "").trim();
    if (!conversationId) {
      throw new Error("conversationId is required");
    }

    upsertConversation({ id: conversationId }, now);
    const createdAt = typeof message.createdAt === "number" ? message.createdAt : now;
    const rowRole = normalizeRole(message.role);
    const content = String(message.content ?? "");
    if (!content.trim()) {
      throw new Error("message content is required");
    }
    stmts.insertConversationMessageStmt.run(
      conversationId,
      message.taskId ?? null,
      rowRole,
      content,
      message.modelId ?? null,
      message.tokenCount ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      createdAt,
    );
    upsertConversation({ id: conversationId, updatedAt: createdAt }, createdAt);
    return { ...message, role: rowRole, content, createdAt };
  };

  const getConversationMessages = (conversationId: string, options?: { limit?: number }): ConversationMessage[] => {
    const id = String(conversationId ?? "").trim();
    if (!id) {
      return [];
    }
    const limit = options?.limit;
    const rows =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? (stmts.getConversationMessagesLimitedStmt.all(id, Math.floor(limit)) as Record<string, unknown>[])
        : (stmts.getConversationMessagesStmt.all(id) as Record<string, unknown>[]);

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
  };

  return { upsertConversation, getConversation, addConversationMessage, getConversationMessages };
}


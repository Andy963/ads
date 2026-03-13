import { parseOptionalSqliteInt, parseSqliteBoolean, parseSqliteJsonObject } from "../utils/sqlite.js";
import type { GraphNode } from "./types.js";

export type SqlDateValue = string | number | Date | null | undefined;

export interface NodeRow {
  id: string;
  type: string;
  label: string | null;
  content?: string | null;
  metadata?: string | Record<string, unknown> | null;
  position?: string | Record<string, unknown> | null;
  current_version?: number | null;
  draft_content?: string | null;
  draft_source_type?: string | null;
  draft_conversation_id?: string | null;
  draft_message_id?: number | string | null;
  draft_based_on_version?: number | null;
  draft_ai_original_content?: string | null;
  draft_updated_at?: SqlDateValue;
  is_draft?: number | boolean | null;
  created_at?: SqlDateValue;
  updated_at?: SqlDateValue;
  workspace_id?: number | null;
}

export function normalizeNodeRow(raw: unknown): NodeRow {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid node row: expected object");
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) {
    throw new Error("Invalid node row: missing id");
  }
  if (typeof row.type !== "string" || !row.type) {
    throw new Error(`Invalid node row ${row.id}: missing type`);
  }

  return {
    ...(raw as NodeRow),
    id: row.id,
    type: row.type,
    label: typeof row.label === "string" ? row.label : String(row.label ?? ""),
  };
}

export function normalizeSqlDate(value: SqlDateValue): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  return new Date(value);
}

export function mapNodeRow(row: NodeRow): GraphNode {
  const metadata = parseSqliteJsonObject(row.metadata, {});
  const position = parseSqliteJsonObject(row.position, { x: 0, y: 0 });
  const draftMessageId = parseOptionalSqliteInt(row.draft_message_id);

  return {
    id: row.id,
    type: row.type,
    label: typeof row.label === "string" ? row.label : "",
    content: row.content ?? null,
    metadata,
    position,
    currentVersion: row.current_version ?? 0,
    draftContent: row.draft_content ?? null,
    isDraft: parseSqliteBoolean(row.is_draft),
    createdAt: normalizeSqlDate(row.created_at),
    updatedAt: normalizeSqlDate(row.updated_at),
    draftSourceType: row.draft_source_type ?? null,
    draftConversationId: row.draft_conversation_id ?? null,
    draftMessageId,
    draftBasedOnVersion: row.draft_based_on_version ?? null,
    draftAiOriginalContent: row.draft_ai_original_content ?? null,
    draftUpdatedAt: normalizeSqlDate(row.draft_updated_at),
  };
}

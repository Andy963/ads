import { getDatabase } from "../storage/database.js";
import { safeParseJson } from "../utils/json.js";
import type { GraphNode, GraphEdge } from "./types.js";

interface CreateNodeInput {
  id: string;
  type: string;
  label: string;
  content?: string | null;
  metadata?: Record<string, unknown>;
  position?: Record<string, unknown>;
  workspaceId?: number | null;
  isDraft?: boolean | null;
}

type NodeUpdateInput = Record<string, unknown>;

type SqlDateValue = string | number | Date | null | undefined;

export interface NodeRow {
  id: string;
  type: string;
  label: string;
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

interface EdgeRow {
  id: string;
  source: string;
  target: string;
  source_handle?: string | null;
  target_handle?: string | null;
  label?: string | null;
  edge_type: string;
  animated?: number | boolean | null;
  created_at?: SqlDateValue;
  updated_at?: SqlDateValue;
}

function normalizeDate(value: SqlDateValue): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  return new Date(value);
}

function parseJsonColumn(
  value: string | Record<string, unknown> | null | undefined,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof value === "string") {
    return safeParseJson<Record<string, unknown>>(value) ?? fallback;
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return fallback;
}

function mapNode(row: NodeRow): GraphNode {
  const metadata = parseJsonColumn(row.metadata ?? null, {});
  const position = parseJsonColumn(row.position ?? null, { x: 0, y: 0 });

  const draftMessageIdRaw = row.draft_message_id;
  let draftMessageId: number | null = null;
  if (typeof draftMessageIdRaw === "number") {
    draftMessageId = draftMessageIdRaw;
  } else if (draftMessageIdRaw !== undefined && draftMessageIdRaw !== null) {
    const numeric = Number(draftMessageIdRaw);
    draftMessageId = Number.isFinite(numeric) ? numeric : null;
  }

  return {
    id: row.id,
    type: row.type,
    label: row.label,
    content: row.content ?? null,
    metadata,
    position,
    currentVersion: row.current_version ?? 0,
    draftContent: row.draft_content ?? null,
    isDraft: Boolean(row.is_draft),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    draftSourceType: row.draft_source_type ?? null,
    draftConversationId: row.draft_conversation_id ?? null,
    draftMessageId,
    draftBasedOnVersion: row.draft_based_on_version ?? null,
    draftAiOriginalContent: row.draft_ai_original_content ?? null,
    draftUpdatedAt: normalizeDate(row.draft_updated_at),
  };
}

function mapEdge(row: EdgeRow): GraphEdge {
  const animated =
    typeof row.animated === "boolean" ? row.animated : Number(row.animated) === 1;

  return {
    id: row.id,
    source: row.source,
    target: row.target,
    sourceHandle: row.source_handle ?? null,
    targetHandle: row.target_handle ?? null,
    label: row.label ?? null,
    edgeType: row.edge_type,
    animated,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

export function getAllNodes(): GraphNode[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM nodes ORDER BY created_at ASC").all() as NodeRow[];
  return rows.map(mapNode);
}

export function getNodeById(nodeId: string): GraphNode | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRow | undefined;
  if (!row) {
    return null;
  }
  return mapNode(row);
}

export function createNode(input: CreateNodeInput): GraphNode {
  const db = getDatabase();
  const now = new Date().toISOString();

  const hasContent = typeof input.content === "string" && input.content.trim().length > 0;
  const isDraftValue =
    input.isDraft === undefined || input.isDraft === null
      ? !hasContent
      : Boolean(input.isDraft);
  const draftContent = isDraftValue && hasContent ? input.content ?? "" : null;
  const currentVersion = hasContent && !isDraftValue ? 1 : 0;

  const insert = db.prepare(`
    INSERT INTO nodes (
      id,
      type,
      label,
      content,
      metadata,
      position,
      current_version,
      draft_content,
      draft_source_type,
      draft_conversation_id,
      draft_message_id,
      draft_based_on_version,
      draft_ai_original_content,
      is_draft,
      draft_updated_at,
      created_at,
      updated_at,
      workspace_id
    ) VALUES (
      @id,
      @type,
      @label,
      @content,
      @metadata,
      @position,
      @current_version,
      @draft_content,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      @is_draft,
      NULL,
      @created_at,
      @updated_at,
      @workspace_id
    )
  `);

  insert.run({
    id: input.id,
    type: input.type,
    label: input.label,
    content: input.content ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
    position: JSON.stringify(input.position ?? { x: 0, y: 0 }),
    current_version: currentVersion,
    draft_content: draftContent,
    is_draft: isDraftValue ? 1 : 0,
    created_at: now,
    updated_at: now,
    workspace_id: input.workspaceId ?? null,
  });

  return getNodeById(input.id)!;
}

export function updateNode(nodeId: string, updates: NodeUpdateInput): GraphNode | null {
  if (!updates || Object.keys(updates).length === 0) {
    return getNodeById(nodeId);
  }

  const db = getDatabase();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: nodeId };

  const setField = (column: string, value: unknown): void => {
    fields.push(`${column} = @${column}`);
    params[column] = value;
  };

  for (const [key, value] of Object.entries(updates)) {
    switch (key) {
      case "label":
        setField("label", value);
        break;
      case "content":
        setField("content", value);
        break;
      case "metadata":
        setField("metadata", JSON.stringify(value ?? {}));
        break;
      case "position":
        setField("position", JSON.stringify(value ?? { x: 0, y: 0 }));
        break;
      case "current_version":
        setField("current_version", value);
        break;
      case "draft_content":
        setField("draft_content", value);
        break;
      case "is_draft":
        setField("is_draft", value ? 1 : 0);
        break;
      case "draft_source_type":
      case "draft_conversation_id":
      case "draft_message_id":
      case "draft_based_on_version":
      case "draft_ai_original_content":
      case "draft_updated_at":
        setField(key, value);
        break;
      default:
        break;
    }
  }

  if (fields.length === 0) {
    return getNodeById(nodeId);
  }

  fields.push("updated_at = @updated_at");
  params.updated_at = new Date().toISOString();

  const sql = `UPDATE nodes SET ${fields.join(", ")} WHERE id = @id`;
  db.prepare(sql).run(params);

  return getNodeById(nodeId);
}

export function deleteNode(nodeId: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  return result.changes > 0;
}

export function getAllEdges(): GraphEdge[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM edges ORDER BY created_at ASC").all() as EdgeRow[];
  return rows.map((row) => mapEdge(row));
}

export function createEdge(input: {
  id: string;
  source: string;
  target: string;
  edgeType?: string;
  label?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  animated?: boolean;
}): GraphEdge {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO edges (
      id,
      source,
      target,
      source_handle,
      target_handle,
      label,
      edge_type,
      animated,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @source,
      @target,
      @source_handle,
      @target_handle,
      @label,
      @edge_type,
      @animated,
      @created_at,
      @updated_at
    )
  `).run({
    id: input.id,
    source: input.source,
    target: input.target,
    source_handle: input.sourceHandle ?? "right",
    target_handle: input.targetHandle ?? "left",
    label: input.label ?? "",
    edge_type: input.edgeType ?? "next",
    animated: input.animated ? 1 : 0,
    created_at: now,
    updated_at: now,
  });

  const row = db.prepare("SELECT * FROM edges WHERE id = ?").get(input.id) as EdgeRow;
  return mapEdge(row);
}

export function deleteEdge(edgeId: string): boolean {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM edges WHERE id = ?").run(edgeId);
  return result.changes > 0;
}

export function getEdgesFromNode(nodeId: string): GraphEdge[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM edges WHERE source = ?").all(nodeId) as EdgeRow[];
  return rows.map((row) => mapEdge(row));
}

export function getNextNode(nodeId: string): GraphNode | null {
  const db = getDatabase();
  const edge = db
    .prepare("SELECT target FROM edges WHERE source = ? AND edge_type = 'next' LIMIT 1")
    .get(nodeId) as { target?: string } | undefined;
  if (!edge?.target) {
    return null;
  }
  return getNodeById(edge.target);
}

export function getParentNodes(nodeId: string, recursive = true): GraphNode[] {
  const db = getDatabase();
  const parents: GraphNode[] = [];
  const seen = new Set<string>();
  let current = nodeId;

  while (true) {
    const edge = db
      .prepare("SELECT source FROM edges WHERE target = ? AND source != ? LIMIT 1")
      .get(current, current) as { source?: string } | undefined;
    if (!edge?.source) {
      break;
    }
    if (seen.has(edge.source)) {
      break;
    }

    const node = getNodeById(edge.source);
    if (!node) {
      break;
    }

    parents.push(node);
    seen.add(node.id);

    if (!recursive) {
      break;
    }
    current = node.id;
  }

  return parents;
}

export function getNodeContext(nodeId: string): { node: GraphNode; parents: GraphNode[] } | null {
  const node = getNodeById(nodeId);
  if (!node) {
    return null;
  }
  const parents = getParentNodes(nodeId, true);
  return { node, parents };
}

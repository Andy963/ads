import Database from "better-sqlite3";

import { getWorkspaceDbPath } from "../../detector.js";
import type { GraphNode } from "../../../graph/types.js";
import { parseOptionalSqliteInt, parseSqliteBoolean, parseSqliteJsonObject } from "../../../utils/sqlite.js";

import type { NodeDbRow } from "./types.js";

function mapDbRowToNode(row: NodeDbRow): GraphNode {
  const metadata = parseSqliteJsonObject(row.metadata, {});
  const position = parseSqliteJsonObject(row.position, { x: 0, y: 0 });
  const draftMessageId = parseOptionalSqliteInt(row.draft_message_id);

  return {
    id: row.id,
    type: row.type,
    label: row.label ?? "",
    content: row.content ?? null,
    metadata,
    position,
    currentVersion: row.current_version ?? 0,
    draftContent: row.draft_content ?? null,
    isDraft: parseSqliteBoolean(row.is_draft),
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
    draftSourceType: row.draft_source_type ?? null,
    draftConversationId: row.draft_conversation_id ?? null,
    draftMessageId,
    draftBasedOnVersion: row.draft_based_on_version ?? null,
    draftAiOriginalContent: row.draft_ai_original_content ?? null,
    draftUpdatedAt: row.draft_updated_at ? new Date(row.draft_updated_at) : null,
  };
}

export function getNodeFromWorkspace(nodeId: string, workspace: string): GraphNode | null {
  const dbPath = getWorkspaceDbPath(workspace);
  const db = new Database(dbPath, { readonly: true });

  try {
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeDbRow | undefined;
    if (!row) {
      return null;
    }
    return mapDbRowToNode(row);
  } finally {
    db.close();
  }
}

export function getAllNodesFromWorkspace(workspace: string): GraphNode[] {
  const dbPath = getWorkspaceDbPath(workspace);
  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db.prepare("SELECT * FROM nodes ORDER BY created_at ASC").all() as NodeDbRow[];
    return rows.map((row) => mapDbRowToNode(row));
  } finally {
    db.close();
  }
}

export function getParentNodesFromWorkspace(nodeId: string, workspace: string, recursive = true): GraphNode[] {
  const dbPath = getWorkspaceDbPath(workspace);
  const db = new Database(dbPath, { readonly: true });

  try {
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

      const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(edge.source) as NodeDbRow | undefined;
      if (!row) {
        break;
      }

      const node = mapDbRowToNode(row);
      parents.push(node);
      seen.add(node.id);

      if (!recursive) {
        break;
      }
      current = node.id;
    }

    return parents;
  } finally {
    db.close();
  }
}

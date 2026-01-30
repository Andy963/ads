import Database from "better-sqlite3";

import { getWorkspaceDbPath } from "../../detector.js";
import type { GraphNode } from "../../../graph/types.js";
import { safeParseJson } from "../../../utils/json.js";

import type { NodeDbRow } from "./types.js";

function mapDbRowToNode(row: NodeDbRow): GraphNode {
  const metadataValue = typeof row.metadata === "string" ? safeParseJson<unknown>(row.metadata) : row.metadata;
  const metadata =
    metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
      ? (metadataValue as Record<string, unknown>)
      : {};

  const positionValue = typeof row.position === "string" ? safeParseJson<unknown>(row.position) : row.position;
  const position =
    positionValue && typeof positionValue === "object" && !Array.isArray(positionValue)
      ? (positionValue as Record<string, unknown>)
      : { x: 0, y: 0 };

  const draftMessageId =
    typeof row.draft_message_id === "number"
      ? row.draft_message_id
      : typeof row.draft_message_id === "string" && row.draft_message_id.trim().length > 0
        ? (() => {
            const parsed = Number.parseInt(row.draft_message_id as string, 10);
            return Number.isNaN(parsed) ? null : parsed;
          })()
        : null;

  return {
    id: row.id,
    type: row.type,
    label: row.label ?? "",
    content: row.content ?? null,
    metadata,
    position,
    currentVersion: row.current_version ?? 0,
    draftContent: row.draft_content ?? null,
    isDraft: Boolean(row.is_draft),
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


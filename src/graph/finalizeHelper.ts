import { getDatabase } from "../storage/database.js";
import { getNodeById } from "./crud.js";
import type { NodeRow } from "./crud.js";
import type { GraphNode } from "./types.js";

class NodeNotFoundError extends Error {}
class InvalidOperationError extends Error {}

export async function finalizeNode(nodeId: string, changeDescription?: string): Promise<GraphNode> {
  const db = getDatabase();
  const transaction = db.transaction(() => {
    const nodeRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRow | undefined;
    if (!nodeRow) {
      throw new NodeNotFoundError("Node not found");
    }
    if (!nodeRow.is_draft) {
      throw new InvalidOperationError("没有草稿可以定稿");
    }

    const newVersion = (nodeRow.current_version ?? 0) + 1;

    db.prepare(
      `INSERT INTO node_versions (
        node_id,
        version,
        content,
        source_type,
        conversation_id,
        message_id,
        based_on_version,
        change_description,
        created_at,
        updated_at
      ) VALUES (
        @node_id,
        @version,
        @content,
        @source_type,
        @conversation_id,
        @message_id,
        @based_on_version,
        @change_description,
        datetime('now'),
        datetime('now')
      )`,
    ).run({
      node_id: nodeId,
      version: newVersion,
      content: nodeRow.draft_content,
      source_type: nodeRow.draft_source_type ?? 'manual',
      conversation_id: nodeRow.draft_conversation_id,
      message_id: nodeRow.draft_message_id,
      based_on_version: nodeRow.draft_based_on_version,
      change_description: changeDescription ?? null,
    });

    db.prepare(
      `UPDATE nodes SET
        content = draft_content,
        current_version = @current_version,
        draft_content = NULL,
        draft_source_type = NULL,
        draft_conversation_id = NULL,
        draft_message_id = NULL,
        draft_based_on_version = NULL,
        draft_ai_original_content = NULL,
        is_draft = 0,
        draft_updated_at = NULL,
        updated_at = datetime('now')
      WHERE id = @id`,
    ).run({
      id: nodeId,
      current_version: newVersion,
    });
  });

  try {
    transaction();
  } catch (error) {
    if (error instanceof NodeNotFoundError || error instanceof InvalidOperationError) {
      throw error;
    }
    throw new Error(`Finalize node failed: ${(error as Error).message}`);
  }

  const updated = getNodeById(nodeId);
  if (!updated) {
    throw new Error("Finalize succeeded but node not found afterwards");
  }
  return updated;
}

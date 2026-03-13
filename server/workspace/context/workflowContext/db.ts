import Database from "better-sqlite3";

import { getWorkspaceDbPath } from "../../detector.js";
import type { GraphNode } from "../../../graph/types.js";
import { mapNodeRow } from "../../../graph/nodeRow.js";

import type { NodeDbRow } from "./types.js";

export function getNodeFromWorkspace(nodeId: string, workspace: string): GraphNode | null {
  const dbPath = getWorkspaceDbPath(workspace);
  const db = new Database(dbPath, { readonly: true });

  try {
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeDbRow | undefined;
    if (!row) {
      return null;
    }
    return mapNodeRow(row);
  } finally {
    db.close();
  }
}

export function getAllNodesFromWorkspace(workspace: string): GraphNode[] {
  const dbPath = getWorkspaceDbPath(workspace);
  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db.prepare("SELECT * FROM nodes ORDER BY created_at ASC").all() as NodeDbRow[];
    return rows.map((row) => mapNodeRow(row));
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

      const node = mapNodeRow(row);
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

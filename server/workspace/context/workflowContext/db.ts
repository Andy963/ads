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
    if (!recursive) {
      const edge = db
        .prepare("SELECT source FROM edges WHERE target = ? AND source != ? LIMIT 1")
        .get(nodeId, nodeId) as { source?: string } | undefined;

      if (!edge?.source) {
        return [];
      }

      const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(edge.source) as NodeDbRow | undefined;
      return row ? [mapNodeRow(row)] : [];
    }

    const sql = `
      WITH RECURSIVE lineage AS (
        -- Anchor: find all parents of the start node
        SELECT source, target, 1 as depth, '/' || target || '/' || source || '/' as path
        FROM edges
        WHERE target = ? AND source != target

        UNION ALL

        -- Recursive: find parents of the previous parents
        SELECT e.source, e.target, l.depth + 1, l.path || e.source || '/'
        FROM edges e
        JOIN lineage l ON e.target = l.source
        WHERE e.source != e.target
          AND l.depth < 100
          AND l.path NOT LIKE '%/' || e.source || '/%'
      )
      SELECT n.*
      FROM lineage l
      JOIN nodes n ON n.id = l.source
      GROUP BY n.id
      ORDER BY min(l.depth) ASC;
    `;

    const rows = db.prepare(sql).all(nodeId) as NodeDbRow[];
    return rows.map((row) => mapNodeRow(row));
  } finally {
    db.close();
  }
}

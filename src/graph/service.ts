import path from "node:path";

import {
  getWorkspaceInfo as detectorWorkspaceInfo,
  isWorkspaceInitialized,
} from "../workspace/detector.js";
import {
  getAllNodes,
  getAllEdges,
  getNodeById,
  getNodeContext as fetchNodeContext,
  createNode,
  updateNode,
  createEdge,
} from "./crud.js";
import { syncAllNodes, saveNodeToFile } from "./fileManager.js";
import { generateNodeId } from "./workflowConfig.js";
import { safeStringify } from "../utils/json.js";
import { getErrorMessage } from "../utils/error.js";
import type { GraphNode } from "./types.js";
import { detectWorkspace } from "../workspace/detector.js";
import { withWorkspaceContext } from "../workspace/asyncWorkspaceContext.js";
import { finalizeNode as finalizeGraphNodeHelper } from "./finalizeHelper.js";

async function withWorkspaceEnv<T>(workspacePath: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  return await withWorkspaceContext(workspacePath, fn);
}

export async function getWorkspaceInfo(params: { workspace_path?: string }): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  try {
    if (!isWorkspaceInitialized(workspace)) {
      return safeStringify({
        error: "Workspace not initialized",
        workspace_path: workspace,
        hint: "Initialize the workspace from Web Console or Telegram before using graph commands.",
      });
    }

    return await withWorkspaceEnv(workspace, () => {
      const nodes = getAllNodes();
      const edges = getAllEdges();

      const nodeStats: Record<string, number> = {};
      const statusStats: Record<string, number> = { draft: 0, finalized: 0 };
      for (const node of nodes) {
        nodeStats[node.type] = (nodeStats[node.type] ?? 0) + 1;
        statusStats[node.isDraft ? "draft" : "finalized"] += 1;
      }

      const edgeStats: Record<string, number> = {};
      for (const edge of edges) {
        edgeStats[edge.edgeType] = (edgeStats[edge.edgeType] ?? 0) + 1;
      }

      const info = detectorWorkspaceInfo(workspace);

      return safeStringify({
        workspace: {
          path: workspace,
          name: (info.name as string) ?? path.basename(workspace),
          is_initialized: true,
          db_path: info.db_path,
          rules_dir: info.rules_dir,
          specs_dir: info.specs_dir,
        },
        statistics: {
          nodes: {
            total: nodes.length,
            by_type: nodeStats,
            by_status: statusStats,
          },
          edges: {
            total: edges.length,
            by_type: edgeStats,
          },
        },
      });
    });
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export async function listNodes(params: {
  workspace_path?: string;
  node_type?: string;
  status?: string;
  limit?: number;
}): Promise<string> {
  try {
    const nodes = await withWorkspaceEnv(params.workspace_path ? path.resolve(params.workspace_path) : undefined, () =>
      getAllNodes()
        .filter((node) => !params.node_type || node.type === params.node_type)
        .filter((node) => {
          if (!params.status) {
            return true;
          }
          const isDraft = params.status === "draft";
          return node.isDraft === isDraft;
        })
        .slice(0, params.limit ?? undefined),
    );

    return safeStringify({
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        status: node.isDraft ? "draft" : "finalized",
        created_at: node.createdAt ? node.createdAt.toISOString() : null,
        updated_at: node.updatedAt ? node.updatedAt.toISOString() : null,
      })),
      total: nodes.length,
    });
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export async function getNode(nodeId: string): Promise<string> {
  try {
    const node = getNodeById(nodeId);
    if (!node) {
      return safeStringify({ error: `节点不存在: ${nodeId}` });
    }

    return safeStringify({
      node: {
        id: node.id,
        type: node.type,
        label: node.label,
        content: node.content,
        status: node.isDraft ? "draft" : "finalized",
        current_version: node.currentVersion,
        created_at: node.createdAt ? node.createdAt.toISOString() : null,
        updated_at: node.updatedAt ? node.updatedAt.toISOString() : null,
        position: node.position,
      },
    });
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

function getNodeContextInternal(nodeId: string): { node: GraphNode; parents: GraphNode[] } | null {
  return fetchNodeContext(nodeId);
}

export async function getNodeContext(nodeId: string): Promise<string> {
  try {
    const context = getNodeContextInternal(nodeId);
    if (!context) {
      return safeStringify({ error: `节点不存在: ${nodeId}` });
    }

    const { node, parents } = context;

    let text = "# 任务上下文\n\n";
    if (parents.length > 0) {
      text += "## 父节点链\n\n";
      parents
        .slice()
        .reverse()
        .forEach((parent) => {
          text += `### ${parent.label}\n\n`;
          text += `${parent.content ?? "(无内容)"}\n\n`;
        });
    }

    text += "## 当前节点\n\n";
    text += `### ${node.label}\n\n`;
    text += `${node.content ?? "(无内容)"}\n`;

    return text;
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export async function createGraphNode(params: {
  workspace_path: string;
  node_type: string;
  title: string;
  content: string;
  parent_id?: string;
  status?: string;
}): Promise<string> {
  try {
    const workspacePath = path.resolve(params.workspace_path);
    return await withWorkspaceEnv(workspacePath, () => {
      const nodeId = generateNodeId(params.node_type);
      const isDraft = params.status !== "finalized";

      const node = createNode({
        id: nodeId,
        type: params.node_type,
        label: params.title,
        content: params.content,
        metadata: {},
        isDraft,
      });

      if (params.parent_id) {
        createEdge({
          id: `edge_${params.parent_id}_${nodeId}`,
          source: params.parent_id,
          target: nodeId,
          edgeType: "next",
        });
      }

      const filePath = saveNodeToFile(node, workspacePath);

      return safeStringify({
        success: true,
        node: {
          id: node.id,
          type: node.type,
          label: node.label,
          content: node.content,
          status: node.isDraft ? "draft" : "finalized",
        },
        file: filePath,
      });
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

export async function updateGraphNode(params: {
  node_id: string;
  content?: string;
  status?: string;
}): Promise<string> {
  try {
    const updates: Record<string, unknown> = {};
    if (params.content !== undefined) {
      updates.content = params.content;
      updates.draft_content = params.content;
      updates.is_draft = true;
    }
    if (params.status !== undefined) {
      updates.is_draft = params.status === "draft";
    }

    const node = updateNode(params.node_id, updates);
    if (!node) {
      return safeStringify({ success: false, error: `节点不存在: ${params.node_id}` });
    }

    const filePath = saveNodeToFile(node);

    return safeStringify({
      success: true,
      node: {
        id: node.id,
        type: node.type,
        label: node.label,
        content: node.content,
        status: node.isDraft ? "draft" : "finalized",
      },
      file: filePath,
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

export async function createGraphEdge(params: {
  source_id: string;
  target_id: string;
  edge_type?: string;
}): Promise<string> {
  try {
    const edge = createEdge({
      id: `edge_${params.source_id}_${params.target_id}`,
      source: params.source_id,
      target: params.target_id,
      edgeType: params.edge_type ?? "next",
    });

    return safeStringify({
      success: true,
      edge: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        edge_type: edge.edgeType,
      },
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

export async function finalizeGraphNode(nodeId: string): Promise<string> {
  try {
    const node = await finalizeGraphNodeHelper(nodeId);
    const filePath = saveNodeToFile(node);

    return safeStringify({
      success: true,
      node: {
        id: node.id,
        type: node.type,
        label: node.label,
        status: "finalized",
      },
      file: filePath,
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

export async function syncAllNodesToFiles(params: { workspace_path?: string }): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : undefined;
    const stats = await withWorkspaceEnv(workspace, () => syncAllNodes(workspace));
    return safeStringify({
      success: true,
      statistics: {
        synced: stats.synced,
        errors: stats.errors,
        workflows: stats.workflows,
      },
      files: stats.files,
      indices: stats.indices,
      message: `成功同步 ${stats.synced} 个节点到 ${stats.workflows} 个工作流`,
    });
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

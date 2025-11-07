import fs from "node:fs";
import path from "node:path";

import { getAllNodes, getEdgesFromNode, getNodeById, getParentNodes } from "./crud.js";
import type { GraphNode } from "./types.js";
import { getNodeTypeConfig } from "./workflowConfig.js";
import { getWorkspaceSpecsDir } from "../workspace/detector.js";

function ensureDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function getWorkflowRootId(node: GraphNode): string {
  const parents = getParentNodes(node.id, true);
  if (parents.length > 0) {
    return parents[parents.length - 1].id;
  }
  return node.id;
}

export function getSpecDir(node: GraphNode, workspacePath?: string): string {
  const specsBaseDir = getWorkspaceSpecsDir(workspacePath);
  const workflowRootId = getWorkflowRootId(node);
  const rootNode = getNodeById(workflowRootId);
  const folderName =
    typeof rootNode?.metadata?.spec_folder === "string" && rootNode.metadata.spec_folder
      ? rootNode.metadata.spec_folder
      : workflowRootId;
  const dir = path.join(specsBaseDir, folderName);
  ensureDirectory(dir);
  return dir;
}

function getNodeSequence(node: GraphNode): number {
  const rootId = getWorkflowRootId(node);
  const allNodes: GraphNode[] = [];
  const visited = new Set<string>();

  const traverse = (nodeId: string): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const current = getNodeById(nodeId);
    if (current) {
      allNodes.push(current);
      const edges = getEdgesFromNode(nodeId);
      for (const edge of edges) {
        traverse(edge.target);
      }
    }
  };

  traverse(rootId);
  allNodes.sort((a, b) => {
    const timeA = a.createdAt ? a.createdAt.getTime() : 0;
    const timeB = b.createdAt ? b.createdAt.getTime() : 0;
    return timeA - timeB;
  });

  const index = allNodes.findIndex((entry) => entry.id === node.id);
  return index >= 0 ? index + 1 : 1;
}

export function getNodeFilePath(node: GraphNode, workspacePath?: string): string {
  const specDir = getSpecDir(node, workspacePath);
  const sequence = getNodeSequence(node);
  const nodeConfig = getNodeTypeConfig(node.type);
  const prefix = nodeConfig?.prefix ?? node.type;
  const filename = `${sequence.toString().padStart(2, "0")}-${prefix}.md`;
  return path.join(specDir, filename);
}

export function saveNodeToFile(node: GraphNode, workspacePath?: string): string {
  const filePath = getNodeFilePath(node, workspacePath);
  const status = node.isDraft ? "draft" : "finalized";

  const content = `---
id: ${node.id}
type: ${node.type}
title: ${node.label}
status: ${status}
created_at: ${node.createdAt ? node.createdAt.toISOString() : ""}
updated_at: ${node.updatedAt ? node.updatedAt.toISOString() : ""}
---

# ${node.label}

${node.content ?? "(待补充内容)"}
`;

  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function deleteNodeFile(nodeId: string, workspacePath?: string): boolean {
  const node = getNodeById(nodeId);
  if (!node) {
    return false;
  }

  const filePath = getNodeFilePath(node, workspacePath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function generateIndex(workspacePath?: string): string[] {
  const nodes = getAllNodes();
  const workflows = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    const rootId = getWorkflowRootId(node);
    if (!workflows.has(rootId)) {
      workflows.set(rootId, []);
    }
    workflows.get(rootId)!.push(node);
  }

  const typeNames: Record<string, string> = {
    requirement: "📋 需求分析",
    design: "📐 方案设计",
    implementation: "💻 实施交付",
  };

  const generated: string[] = [];

  for (const [rootId, workflowNodes] of workflows.entries()) {
    const rootNode = workflowNodes.find((node) => node.id === rootId);
    if (!rootNode) {
      continue;
    }

    const specDir = getSpecDir(rootNode, workspacePath);
    const indexPath = path.join(specDir, "README.md");

    const nodesByType = new Map<string, GraphNode[]>();
    for (const node of workflowNodes) {
      if (!nodesByType.has(node.type)) {
        nodesByType.set(node.type, []);
      }
      nodesByType.get(node.type)!.push(node);
    }

    let content = `# ${rootNode.label}

> 自动生成于 ${new Date().toISOString().replace("T", " ").split(".")[0]}

**工作流 ID**: \`${rootId}\`
**根节点类型**: ${typeNames[rootNode.type] ?? rootNode.type}

## 统计

- 节点数: ${workflowNodes.length}
- 草稿节点: ${workflowNodes.filter((node) => node.isDraft).length}
- 已定稿节点: ${workflowNodes.filter((node) => !node.isDraft).length}

## 节点列表

`;

    const sortedTypes = Array.from(nodesByType.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [nodeType, typeNodes] of sortedTypes) {
      const typeName = typeNames[nodeType] ?? nodeType;
      content += `### ${typeName}\n\n`;
      const sortedNodes = typeNodes.slice().sort((a, b) => {
        const timeA = a.createdAt ? a.createdAt.getTime() : 0;
        const timeB = b.createdAt ? b.createdAt.getTime() : 0;
        return timeA - timeB;
      });
      for (const node of sortedNodes) {
        const statusIcon = node.isDraft ? "📝" : "✅";
        content += `- ${statusIcon} [${node.label}](./${node.type}.md)\n`;
      }
      content += "\n";
    }

    fs.writeFileSync(indexPath, content, "utf-8");
    generated.push(indexPath);
  }

  return generated;
}

export function syncAllNodes(workspacePath?: string): {
  synced: number;
  errors: number;
  files: string[];
  workflows: number;
  indices: string[];
} {
  const nodes = getAllNodes();
  const stats = {
    synced: 0,
    errors: 0,
    files: [] as string[],
    workflows: 0,
    indices: [] as string[],
  };

  for (const node of nodes) {
    try {
      const filePath = saveNodeToFile(node, workspacePath);
      stats.synced += 1;
      stats.files.push(filePath);
    } catch (error) {
      stats.errors += 1;
      console.warn(`Error syncing node ${node.id}: ${(error as Error).message}`);
    }
  }

  try {
    const indices = generateIndex(workspacePath);
    stats.workflows = indices.length;
    stats.indices = indices;
  } catch (error) {
    console.warn(`Error generating indices: ${(error as Error).message}`);
  }

  return stats;
}

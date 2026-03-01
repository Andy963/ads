import fs from "node:fs";
import path from "node:path";

import { getAllNodes, getEdgesFromNode, getNodeById, getParentNodes } from "./crud.js";
import type { GraphNode } from "./types.js";
import { getNodeTypeConfig } from "./workflowConfig.js";
import { getWorkspaceSpecsDir } from "../workspace/detector.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("GraphFileManager");

function ensureDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function compareNodesByCreatedAt(a: GraphNode, b: GraphNode): number {
  const timeA = a.createdAt ? a.createdAt.getTime() : 0;
  const timeB = b.createdAt ? b.createdAt.getTime() : 0;
  return timeA - timeB;
}

function renderNodeFileContent(node: GraphNode): string {
  const status = node.isDraft ? "draft" : "finalized";
  return `---
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

function getSpecDirForWorkflowRoot(
  workflowRootId: string,
  rootNode: GraphNode | null,
  workspacePath?: string,
): string {
  const specsBaseDir = getWorkspaceSpecsDir(workspacePath);
  const folderName =
    typeof rootNode?.metadata?.spec_folder === "string" && rootNode.metadata.spec_folder
      ? rootNode.metadata.spec_folder
      : workflowRootId;
  const dir = path.join(specsBaseDir, folderName);
  ensureDirectory(dir);
  return dir;
}

function getNodeFilePathForSequence(node: GraphNode, specDir: string, sequence: number): string {
  const nodeConfig = getNodeTypeConfig(node.type);
  const prefix = nodeConfig?.prefix ?? node.type;
  const filename = `${sequence.toString().padStart(2, "0")}-${prefix}.md`;
  return path.join(specDir, filename);
}

function buildNodeSequenceMap(nodes: GraphNode[]): Map<string, number> {
  const sorted = nodes.slice().sort(compareNodesByCreatedAt);
  const sequences = new Map<string, number>();
  for (let i = 0; i < sorted.length; i += 1) {
    sequences.set(sorted[i].id, i + 1);
  }
  return sequences;
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
  allNodes.sort(compareNodesByCreatedAt);

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
  fs.writeFileSync(filePath, renderNodeFileContent(node), "utf-8");
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
    const rootNode = workflowNodes.find((node) => node.id === rootId) ?? getNodeById(rootId);
    if (!rootNode) {
      continue;
    }

    const specDir = getSpecDirForWorkflowRoot(rootId, rootNode, workspacePath);
    const indexPath = path.join(specDir, "README.md");
    const sequences = buildNodeSequenceMap(workflowNodes);

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
      const sortedNodes = typeNodes.slice().sort(compareNodesByCreatedAt);
      for (const node of sortedNodes) {
        const statusIcon = node.isDraft ? "📝" : "✅";
        const sequence = sequences.get(node.id) ?? 1;
        const filePath = getNodeFilePathForSequence(node, specDir, sequence);
        const linkPath = path.relative(specDir, filePath).split(path.sep).join("/");
        content += `- ${statusIcon} [${node.label}](./${linkPath})\n`;
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
  const workflows = new Map<string, GraphNode[]>();
  const workflowRoots = new Map<string, string>();

  for (const node of nodes) {
    const rootId = getWorkflowRootId(node);
    workflowRoots.set(node.id, rootId);
    const group = workflows.get(rootId);
    if (group) {
      group.push(node);
    } else {
      workflows.set(rootId, [node]);
    }
  }

  const specDirs = new Map<string, string>();
  const sequences = new Map<string, number>();
  for (const [rootId, workflowNodes] of workflows.entries()) {
    const rootNode = workflowNodes.find((node) => node.id === rootId) ?? getNodeById(rootId);
    const specDir = getSpecDirForWorkflowRoot(rootId, rootNode, workspacePath);
    specDirs.set(rootId, specDir);
    for (const [nodeId, sequence] of buildNodeSequenceMap(workflowNodes).entries()) {
      sequences.set(nodeId, sequence);
    }
  }

  const stats = {
    synced: 0,
    errors: 0,
    files: [] as string[],
    workflows: 0,
    indices: [] as string[],
  };

  for (const node of nodes) {
    try {
      const rootId = workflowRoots.get(node.id) ?? node.id;
      const specDir = specDirs.get(rootId);
      if (!specDir) {
        throw new Error(`Missing spec directory for workflow root ${rootId}`);
      }
      const sequence = sequences.get(node.id) ?? 1;
      const filePath = getNodeFilePathForSequence(node, specDir, sequence);
      fs.writeFileSync(filePath, renderNodeFileContent(node), "utf-8");
      stats.synced += 1;
      stats.files.push(filePath);
    } catch (error) {
      stats.errors += 1;
      logger.warn(`Error syncing node ${node.id}: ${(error as Error).message}`, error);
    }
  }

  try {
    const indices = generateIndex(workspacePath);
    stats.workflows = indices.length;
    stats.indices = indices;
  } catch (error) {
    logger.warn(`Error generating indices: ${(error as Error).message}`, error);
  }

  return stats;
}

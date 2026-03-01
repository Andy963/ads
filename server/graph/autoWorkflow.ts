import { createNode, createEdge, getEdgesFromNode, getNodeById } from "./crud.js";
import { generateNodeId } from "./workflowConfig.js";
import type { GraphNode } from "./types.js";

export interface WorkflowNodeConfig {
  node_type: string;
  label_suffix: string;
  required: boolean;
}

export interface WorkflowCreationResult {
  nodes: GraphNode[];
  edges: {
    id: string;
    source: string;
    target: string;
  }[];
}

interface FlowRule {
  next_type: string | null;
  label_template?: string;
  next_label_template?: string;
}

const FLOW_RULES: Record<string, FlowRule> = {
  requirement: {
    next_type: "design",
    label_template: "{parent_label}-设计",
    next_label_template: "{parent_label} - 设计方案",
  },
  design: {
    next_type: "implementation",
    label_template: "{parent_label}-实现",
    next_label_template: "{parent_label} - 实施计划",
  },
  implementation: {
    next_type: null,
  },
  task: {
    next_type: null,
  },
};

export function createWorkflowFromConfig(params: {
  nodes: WorkflowNodeConfig[];
  rootLabel: string;
  rootContent?: string;
  position?: { x: number; y: number };
}): WorkflowCreationResult {
  const { nodes, rootLabel, rootContent = "", position } = params;
  if (!nodes || nodes.length === 0) {
    throw new Error("节点列表不能为空");
  }

  const startPosition = position ?? { x: 100, y: 100 };
  const createdNodes: GraphNode[] = [];
  const createdEdges: WorkflowCreationResult["edges"] = [];

  let currentX = startPosition.x;
  const currentY = startPosition.y;
  const offsetX = 250;
  let previousNode: GraphNode | null = null;

  for (const [index, nodeConfig] of nodes.entries()) {
    const nodeId = generateNodeId(nodeConfig.node_type);
    const nodeLabel = `${rootLabel} - ${nodeConfig.label_suffix}`;

    const node = createNode({
      id: nodeId,
      type: nodeConfig.node_type,
      label: nodeLabel,
      content: index === 0 ? rootContent : "",
      metadata: {
        workflow: rootLabel,
        step: index + 1,
        required: nodeConfig.required,
      },
      position: { x: currentX, y: currentY },
      isDraft: true, // 工作流节点始终创建为草稿，需要用户 commit 后才定稿
    });

    createdNodes.push(node);

    if (previousNode) {
      const edgeId = `edge_${previousNode.id}_${node.id}`;
      createEdge({
        id: edgeId,
        source: previousNode.id,
        target: node.id,
        edgeType: "next",
        label: "下一步",
        sourceHandle: "right",
        targetHandle: "left",
      });
      createdEdges.push({ id: edgeId, source: previousNode.id, target: node.id });
    }

    previousNode = node;
    currentX += offsetX;
  }

  return { nodes: createdNodes, edges: createdEdges };
}

function findNextNodeOfType(nodeId: string, nextType: string): GraphNode | null {
  for (const edge of getEdgesFromNode(nodeId)) {
    const nextNode = getNodeById(edge.target);
    if (nextNode?.type === nextType) {
      return nextNode;
    }
  }
  return null;
}

export function onNodeFinalized(nodeId: string): {
  action?: "activated_existing" | "created_new";
  node_id?: string;
  node_label?: string;
  workflow_completed?: boolean;
  message: string;
} | null {
  const node = getNodeById(nodeId);
  if (!node) {
    return null;
  }

  const rule = FLOW_RULES[node.type];
  const nextType = rule?.next_type;
  if (!rule || !nextType) {
    return {
      workflow_completed: true,
      message: `工作流已完成，节点 ${node.label} 是最后一个节点`,
    };
  }

  const existingNextNode = findNextNodeOfType(nodeId, nextType);
  if (existingNextNode) {
    return {
      action: "activated_existing",
      node_id: existingNextNode.id,
      node_label: existingNextNode.label,
      message: `已激活现有节点: ${existingNextNode.label}`,
    };
  }

  const parentLabelBase = node.label.replace(/ - .+$/, "");
  const labelTemplate = rule.next_label_template ?? rule.label_template ?? "{parent_label}";
  const newLabel = labelTemplate.replace("{parent_label}", parentLabelBase);

  const position = node.position ?? {};
  const parentX = typeof position.x === "number" ? position.x : 100;
  const parentY = typeof position.y === "number" ? position.y : 100;

  const newNode = createNode({
    id: generateNodeId(nextType),
    type: nextType,
    label: newLabel,
    content: "",
    metadata: {
      auto_created: true,
      parent_node_id: nodeId,
      created_at: new Date().toISOString(),
    },
    position: {
      x: parentX + 350,
      y: parentY,
    },
    isDraft: true,
  });

  createEdge({
    id: `edge_${nodeId}_${newNode.id}`,
    source: nodeId,
    target: newNode.id,
    edgeType: "next",
    label: "自动流转",
    sourceHandle: "right",
    targetHandle: "left",
  });

  return {
    action: "created_new",
    node_id: newNode.id,
    node_label: newNode.label,
    message: `已创建新节点: ${newNode.label}`,
  };
}

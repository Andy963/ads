import { getAllNodes, getNodeById, getParentNodes } from "../../../graph/crud.js";
import type { GraphNode } from "../../../graph/types.js";

import { STEP_MAPPINGS, TYPE_KEYWORDS } from "./constants.js";
import type { WorkflowInfo, WorkflowSteps, WorkflowSummary } from "./types.js";
import { getAllNodesFromWorkspace, getNodeFromWorkspace, getParentNodesFromWorkspace } from "./db.js";

export function collectWorkflowNodes(workflowId: string, workspace?: string): GraphNode[] {
  const allNodes = workspace ? getAllNodesFromWorkspace(workspace) : getAllNodes();
  const nodes: GraphNode[] = [];

  for (const node of allNodes) {
    const parents = workspace ? getParentNodesFromWorkspace(node.id, workspace, true) : getParentNodes(node.id, true);
    const rootId = parents.length > 0 ? parents[parents.length - 1].id : node.id;
    if (rootId === workflowId) {
      nodes.push(node);
    }
  }

  return nodes;
}

export function listAllWorkflows(workspace?: string): WorkflowSummary[] {
  const nodes = workspace ? getAllNodesFromWorkspace(workspace) : getAllNodes();
  const workflows = new Map<string, { root: GraphNode; nodes: GraphNode[]; template: string }>();

  for (const node of nodes) {
    const parents = workspace ? getParentNodesFromWorkspace(node.id, workspace, true) : getParentNodes(node.id, true);
    const rootId = parents.length > 0 ? parents[parents.length - 1].id : node.id;

    if (!workflows.has(rootId)) {
      const rootNode = workspace ? getNodeFromWorkspace(rootId, workspace) : getNodeById(rootId);
      if (!rootNode) {
        continue;
      }
      let template = "unknown";
      const metadata = rootNode.metadata ?? {};
      if (typeof metadata === "object" && metadata !== null && "workflow_template" in metadata) {
        template = String((metadata as Record<string, unknown>).workflow_template);
      }
      workflows.set(rootId, { root: rootNode, nodes: [], template });
    }

    workflows.get(rootId)!.nodes.push(node);
  }

  const result: WorkflowSummary[] = [];
  for (const [rootId, workflow] of workflows.entries()) {
    let template = workflow.template;
    if (template === "unknown") {
      const nodeTypes = new Set(workflow.nodes.map((node) => node.type));
      if (["requirement", "design", "implementation"].every((type) => nodeTypes.has(type))) {
        template = "unified";
      }
    }

    result.push({
      workflow_id: rootId,
      template,
      title: workflow.root.label,
      node_count: workflow.nodes.length,
      finalized_count: workflow.nodes.filter((node) => !node.isDraft && (node.currentVersion ?? 0) > 0).length,
      created_at: workflow.root.createdAt ? workflow.root.createdAt.toISOString() : null,
    });
  }

  result.sort((a, b) => {
    const timeA = a.created_at ?? "";
    const timeB = b.created_at ?? "";
    return timeB.localeCompare(timeA);
  });

  return result;
}

export function switchWorkflow(
  workflowIdentifier: string,
  workspace: string | undefined,
  setActiveWorkflow: (params: {
    workspace?: string;
    workflowRootId: string;
    template?: string | null;
    title?: string | null;
    steps?: WorkflowSteps | null;
  }) => WorkflowInfo,
): { success: boolean; workflow: WorkflowInfo | null; matches: WorkflowSummary[]; message: string } {
  const normalizedId = (workflowIdentifier ?? "").toString();
  if (!normalizedId.trim()) {
    return {
      success: false,
      workflow: null,
      matches: [],
      message: "未找到匹配 '' 的工作流",
    };
  }

  const allWorkflows = listAllWorkflows(workspace);
  if (allWorkflows.length === 0) {
    return {
      success: false,
      workflow: null,
      matches: [],
      message: "没有找到任何工作流",
    };
  }

  let matched: WorkflowSummary | undefined = allWorkflows.find((wf) => wf.workflow_id === normalizedId);

  if (!matched) {
    const index = parseInt(normalizedId, 10);
    if (!Number.isNaN(index) && index >= 1 && index <= allWorkflows.length) {
      matched = allWorkflows[index - 1];
    }
  }

  if (!matched) {
    matched = allWorkflows.find((wf) => wf.title === normalizedId);
  }

  let matches: WorkflowSummary[] = [];

  if (!matched) {
    const templateType = TYPE_KEYWORDS[normalizedId.toLowerCase()];
    if (templateType) {
      matches = allWorkflows.filter((wf) => wf.template === templateType);
      if (matches.length > 0) {
        matched = matches[0];
      }
    }
  }

  if (!matched) {
    matched = allWorkflows.find((wf) => {
      const title = wf.title ?? "";
      return title.toLowerCase().includes(normalizedId.toLowerCase());
    });
  }

  if (!matched && normalizedId.toLowerCase() === "unified") {
    matched = allWorkflows.find((wf) => wf.template === "unified");
  }

  if (!matched) {
    return {
      success: false,
      workflow: null,
      matches: [],
      message: `未找到匹配 '${normalizedId}' 的工作流`,
    };
  }

  const workflowNodes = collectWorkflowNodes(matched.workflow_id, workspace);
  const stepMapping = STEP_MAPPINGS[matched.template] ?? {};
  const steps: WorkflowSteps = {};

  for (const [stepName, nodeType] of Object.entries(stepMapping)) {
    const node = workflowNodes.find((item) => item.type === nodeType);
    if (node) {
      steps[stepName] = node.id;
    }
  }

  const workflow = setActiveWorkflow({
    workspace,
    workflowRootId: matched.workflow_id,
    template: matched.template,
    title: matched.title,
    steps,
  });

  return {
    success: true,
    workflow,
    matches: [],
    message: `已切换到工作流: ${matched.title}`,
  };
}


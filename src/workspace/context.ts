import fs from "node:fs";
import path from "node:path";

import { detectWorkspace } from "./detector.js";
import {
  getAllNodes,
  getNodeById,
  getParentNodes,
} from "../graph/crud.js";
import type { GraphNode } from "../graph/types.js";

type WorkflowSteps = Record<string, string>;

export interface WorkflowInfo {
  workflow_id: string;
  template?: string;
  title?: string;
  created_at?: string;
  steps: WorkflowSteps;
  current_step?: string | null;
}

interface WorkflowContextState {
  active_workflow_id: string | null;
  active_workflow: WorkflowInfo | null;
  workflows: Record<string, WorkflowInfo>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

export class WorkflowContext {
  static readonly CONTEXT_FILE = ".ads/context.json";

  static readonly STEP_MAPPINGS: Record<string, WorkflowSteps> = {
    unified: {
      requirement: "requirement",
      design: "design",
      implementation: "implementation",
    },
  };

  static readonly TYPE_KEYWORDS: Record<string, string> = {
    unified: "unified",
    default: "unified",
    "统一": "unified",
    "流程": "unified",
  };

  private static getContextFile(workspace?: string): string {
    const root = workspace ? path.resolve(workspace) : detectWorkspace();
    return path.join(root, WorkflowContext.CONTEXT_FILE);
  }

  static loadContext(workspace?: string): WorkflowContextState {
    const contextFile = WorkflowContext.getContextFile(workspace);
    if (!fs.existsSync(contextFile)) {
      return {
        active_workflow_id: null,
        active_workflow: null,
        workflows: {},
      };
    }

    try {
      const data = fs.readFileSync(contextFile, "utf-8");
      const parsed = JSON.parse(data);
      return WorkflowContext.normalizeContext(parsed);
    } catch {
      return {
        active_workflow_id: null,
        active_workflow: null,
        workflows: {},
      };
    }
  }

  static saveContext(workspace: string | undefined, context: WorkflowContextState): void {
    const root = workspace ? path.resolve(workspace) : detectWorkspace();
    const contextFile = WorkflowContext.getContextFile(root);
    fs.mkdirSync(path.dirname(contextFile), { recursive: true });
    const sanitized = WorkflowContext.normalizeContext(context);
    fs.writeFileSync(contextFile, JSON.stringify(sanitized, null, 2), "utf-8");
  }

  private static normalizeContext(rawContext: any): WorkflowContextState {
    const context = clone(rawContext ?? {}) as Record<string, unknown>;

    let activeWorkflow = (context.active_workflow ?? null) as WorkflowInfo | null;
    let workflows = (context.workflows ?? {}) as Record<string, WorkflowInfo>;
    let activeWorkflowId = (context.active_workflow_id ?? null) as string | null;

    if (typeof workflows !== "object" || workflows === null) {
      workflows = {};
    }

    if (!activeWorkflowId && activeWorkflow && typeof activeWorkflow === "object") {
      activeWorkflowId = activeWorkflow.workflow_id ?? null;
    }

    if ((!activeWorkflow || typeof activeWorkflow !== "object") && activeWorkflowId) {
      const wfData = clone(workflows[activeWorkflowId] ?? null);
      if (wfData) {
        wfData.workflow_id = wfData.workflow_id ?? activeWorkflowId;
        activeWorkflow = wfData;
      } else {
        activeWorkflow = null;
      }
    }

    if (activeWorkflow && activeWorkflow.workflow_id) {
      const workflowId = activeWorkflow.workflow_id;
      const existing = clone(workflows[workflowId] ?? {});
      workflows[workflowId] = {
        workflow_id: workflowId,
        template: activeWorkflow.template ?? existing.template,
        title: activeWorkflow.title ?? existing.title,
        created_at: activeWorkflow.created_at ?? existing.created_at,
        steps: activeWorkflow.steps ?? existing.steps ?? {},
        current_step: activeWorkflow.current_step ?? existing.current_step ?? null,
      };
      activeWorkflowId = workflowId;
    }

    return {
      active_workflow_id: activeWorkflowId ?? null,
      active_workflow: activeWorkflow ?? null,
      workflows,
    };
  }

  static autoActivateIfSingleWorkflow(workspace?: string): WorkflowInfo | null {
    const active = WorkflowContext.getActiveWorkflow(workspace);
    if (active) {
      return null;
    }

    const workflows = WorkflowContext.listAllWorkflows(workspace);
    if (workflows.length === 1) {
      const result = WorkflowContext.switchWorkflow(workflows[0].workflow_id, workspace);
      if (result.success && result.workflow) {
        return result.workflow;
      }
    }
    return null;
  }

  static getActiveWorkflow(workspace?: string): WorkflowInfo | null {
    const contextFile = WorkflowContext.getContextFile(workspace);
    if (!fs.existsSync(contextFile)) {
      return null;
    }
    const context = WorkflowContext.loadContext(workspace);
    return context.active_workflow;
  }

  static setActiveWorkflow(params: {
    workspace?: string;
    workflowRootId: string;
    template?: string | null;
    title?: string | null;
    steps?: WorkflowSteps | null;
  }): WorkflowInfo {
    const { workspace, workflowRootId, template, title, steps } = params;
    const root = workspace ? path.resolve(workspace) : detectWorkspace();
    const context = WorkflowContext.loadContext(root);

    const existing = clone(context.workflows[workflowRootId] ?? {});
    const mergedSteps = steps ?? existing.steps ?? {};

    const workflow: WorkflowInfo = {
      workflow_id: workflowRootId,
      template: template ?? existing.template ?? undefined,
      title: title ?? existing.title ?? workflowRootId,
      steps: mergedSteps,
      current_step:
        existing.current_step ??
        Object.keys(mergedSteps)[0] ??
        null,
      created_at: existing.created_at ?? new Date().toISOString(),
    };

    context.active_workflow_id = workflowRootId;
    context.active_workflow = workflow;
    context.workflows[workflowRootId] = workflow;

    WorkflowContext.saveContext(root, context);
    return workflow;
  }

  static clearActiveWorkflow(workspace?: string): boolean {
    const context = WorkflowContext.loadContext(workspace);
    if (!context.active_workflow_id && !context.active_workflow) {
      return false;
    }

    context.active_workflow_id = null;
    context.active_workflow = null;
    WorkflowContext.saveContext(workspace, context);
    return true;
  }

  static getWorkflowStepNodeId(stepName: string, workflowContext?: WorkflowInfo | null, workspace?: string): string | null {
    const context = workflowContext ?? WorkflowContext.getActiveWorkflow(workspace);
    if (!context) {
      return null;
    }
    return context.steps?.[stepName] ?? null;
  }

  static updateCurrentStep(stepName: string, workspace?: string): void {
    const contextFile = WorkflowContext.getContextFile(workspace);
    if (!fs.existsSync(contextFile)) {
      return;
    }

    const context = WorkflowContext.loadContext(workspace);
    const activeId = context.active_workflow_id;
    if (!activeId) {
      return;
    }

    if (context.active_workflow) {
      context.active_workflow.current_step = stepName;
    }

    if (context.workflows[activeId]) {
      context.workflows[activeId].current_step = stepName;
    }

    WorkflowContext.saveContext(workspace, context);
  }

  static addWorkflowStep(stepName: string, nodeId: string, workspace?: string): void {
    const contextFile = WorkflowContext.getContextFile(workspace);
    if (!fs.existsSync(contextFile)) {
      return;
    }

    const context = WorkflowContext.loadContext(workspace);
    const activeId = context.active_workflow_id;
    if (!activeId) {
      return;
    }

    context.active_workflow = context.active_workflow ?? {
      workflow_id: activeId,
      steps: {},
    };

    context.active_workflow.steps = context.active_workflow.steps ?? {};
    context.active_workflow.steps[stepName] = nodeId;
    context.active_workflow.current_step = stepName;

    const workflows = context.workflows ?? {};
    workflows[activeId] = workflows[activeId] ?? {
      workflow_id: activeId,
      steps: {},
    };
    workflows[activeId].steps = workflows[activeId].steps ?? {};
    workflows[activeId].steps[stepName] = nodeId;
    workflows[activeId].current_step = stepName;
    context.workflows = workflows;

    WorkflowContext.saveContext(workspace, context);
  }

  static listAllWorkflows(workspace?: string): Array<{
    workflow_id: string;
    template: string;
    title: string;
    node_count: number;
    finalized_count: number;
    created_at: string | null;
  }> {
    const nodes = getAllNodes();
    const workflows = new Map<string, { root: GraphNode; nodes: GraphNode[]; template: string }>();

    for (const node of nodes) {
      const parents = getParentNodes(node.id, true);
      const rootId = parents.length > 0 ? parents[parents.length - 1].id : node.id;

      if (!workflows.has(rootId)) {
        const rootNode = getNodeById(rootId);
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

    const result: Array<{
      workflow_id: string;
      template: string;
      title: string;
      node_count: number;
      finalized_count: number;
      created_at: string | null;
    }> = [];

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
        finalized_count: workflow.nodes.filter(
          (node) => !node.isDraft && (node.currentVersion ?? 0) > 0
        ).length,
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

  static switchWorkflow(
    workflowIdentifier: string,
    workspace?: string,
  ): {
    success: boolean;
    workflow: WorkflowInfo | null;
    matches: Array<Record<string, unknown>>;
    message: string;
  } {
    const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
    if (allWorkflows.length === 0) {
      return {
        success: false,
        workflow: null,
        matches: [] as Array<Record<string, unknown>>,
        message: "没有找到任何工作流",
      };
    }

    let matched = allWorkflows.find((wf) => wf.workflow_id === workflowIdentifier);

    // 支持序号选择（1-based index）
    if (!matched) {
      const index = parseInt(workflowIdentifier, 10);
      if (!isNaN(index) && index >= 1 && index <= allWorkflows.length) {
        matched = allWorkflows[index - 1];
      }
    }

    if (!matched) {
      matched = allWorkflows.find((wf) => wf.title === workflowIdentifier);
    }

    let matches: any[] = [];

    if (!matched) {
      const templateType = WorkflowContext.TYPE_KEYWORDS[workflowIdentifier.toLowerCase()];
      if (templateType) {
        matches = allWorkflows.filter((wf) => wf.template === templateType);
        if (matches.length === 1) {
          matched = matches[0] as typeof matched;
        } else if (matches.length > 1) {
          return {
            success: false,
            workflow: null,
            matches: matches as Array<Record<string, unknown>>,
            message: `找到 ${matches.length} 个 '${templateType}' 类型的工作流，请指定具体的工作流`,
          };
        }
      }
    }

    if (!matched) {
      matched = allWorkflows.find((wf) =>
        wf.title.toLowerCase().includes(workflowIdentifier.toLowerCase()),
      );
    }

    if (!matched) {
      return {
        success: false,
        workflow: null,
        matches: [] as Array<Record<string, unknown>>,
        message: `未找到匹配 '${workflowIdentifier}' 的工作流`,
      };
    }

    const workflowNodes = WorkflowContext.collectWorkflowNodes(matched.workflow_id);
    const stepMapping = WorkflowContext.STEP_MAPPINGS[matched.template] ?? {};
    const steps: WorkflowSteps = {};

    for (const [stepName, nodeType] of Object.entries(stepMapping)) {
      const node = workflowNodes.find((item) => item.type === nodeType);
      if (node) {
        steps[stepName] = node.id;
      }
    }

    const workflow = WorkflowContext.setActiveWorkflow({
      workspace,
      workflowRootId: matched.workflow_id,
      template: matched.template,
      title: matched.title,
      steps,
    });

    return {
      success: true,
      workflow,
      matches: [] as Array<Record<string, unknown>>,
      message: `已切换到工作流: ${matched.title}`,
    };
  }

  static collectWorkflowNodes(workflowId: string): GraphNode[] {
    const allNodes = getAllNodes();
    const nodes: GraphNode[] = [];

    for (const node of allNodes) {
      const parents = getParentNodes(node.id, true);
      const rootId = parents.length > 0 ? parents[parents.length - 1].id : node.id;
      if (rootId === workflowId) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  static getWorkflowStatus(workspace?: string): {
    workflow: WorkflowInfo;
    steps: Array<{
      name: string;
      node_id: string;
      label: string;
      status: "draft" | "finalized";
      is_current: boolean;
    }>;
  } | null {
    const workflow = WorkflowContext.getActiveWorkflow(workspace);
    if (!workflow) {
      return null;
    }

    const steps = Object.entries(workflow.steps ?? {}).map(([stepName, nodeId]) => {
      const node = getNodeById(nodeId);
      if (!node) {
        return null;
      }
      return {
        name: stepName,
        node_id: nodeId,
        label: node.label,
        status: node.isDraft ? "draft" as const : "finalized" as const,
        is_current: stepName === workflow.current_step,
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return {
      workflow,
      steps,
    };
  }
}

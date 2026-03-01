import fs from "node:fs";
import path from "node:path";

import { detectWorkspace } from "../detector.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../adsPaths.js";
import { getNodeById } from "../../graph/crud.js";
import type { GraphNode } from "../../graph/types.js";
import { getNodeFilePath } from "../../graph/fileManager.js";

import { CONTEXT_FILE, STEP_MAPPINGS, TYPE_KEYWORDS } from "./workflowContext/constants.js";
import { getNodeFromWorkspace } from "./workflowContext/db.js";
import {
  collectWorkflowNodes as collectWorkflowNodesImpl,
  listAllWorkflows as listAllWorkflowsImpl,
  switchWorkflow as switchWorkflowImpl,
} from "./workflowContext/workflows.js";
import type { WorkflowInfo, WorkflowSteps, WorkflowSummary } from "./workflowContext/types.js";
export type { WorkflowInfo, WorkflowSteps, WorkflowSummary } from "./workflowContext/types.js";

interface WorkflowContextState {
  active_workflow_id: string | null;
  active_workflow: WorkflowInfo | null;
  workflows: Record<string, WorkflowInfo>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

export class WorkflowContext {
  static readonly CONTEXT_FILE = CONTEXT_FILE;

  static readonly STEP_MAPPINGS: Record<string, WorkflowSteps> = STEP_MAPPINGS;

  static readonly TYPE_KEYWORDS: Record<string, string> = TYPE_KEYWORDS;

  private static getContextFile(workspace?: string): string {
    const root = workspace ? path.resolve(workspace) : detectWorkspace();
    migrateLegacyWorkspaceAdsIfNeeded(root);
    return resolveWorkspaceStatePath(root, WorkflowContext.CONTEXT_FILE);
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

  private static normalizeContext(rawContext: unknown): WorkflowContextState {
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

  static listAllWorkflows(workspace?: string): WorkflowSummary[] {
    return listAllWorkflowsImpl(workspace);
  }

  static switchWorkflow(
    workflowIdentifier: string,
    workspace?: string,
  ): {
    success: boolean;
    workflow: WorkflowInfo | null;
    matches: WorkflowSummary[];
    message: string;
  } {
    return switchWorkflowImpl(workflowIdentifier, workspace, (params) => WorkflowContext.setActiveWorkflow(params));
  }



  static getNode(workspace: string | undefined, nodeId: string): GraphNode | null {
    return workspace
      ? getNodeFromWorkspace(nodeId, workspace)
      : getNodeById(nodeId);
  }

  static collectWorkflowNodes(workflowId: string, workspace?: string): GraphNode[] {
    return collectWorkflowNodesImpl(workflowId, workspace);
  }

  static getWorkflowStatus(workspace?: string): {
    workflow: WorkflowInfo;
    steps: Array<{
      name: string;
      node_id: string;
      label: string;
      status: "draft" | "finalized";
      is_current: boolean;
      file_path?: string | null;
    }>;
  } | null {
    const workflow = WorkflowContext.getActiveWorkflow(workspace);
    if (!workflow) {
      return null;
    }

    const workspaceRoot = workspace ? path.resolve(workspace) : detectWorkspace();

    const steps = Object.entries(workflow.steps ?? {}).map(([stepName, nodeId]) => {
      // If workspace is specified, read from that workspace's database
      const node = workspace
        ? getNodeFromWorkspace(nodeId, workspace)
        : getNodeById(nodeId);

      if (!node) {
        return null;
      }

      let filePath: string | null = null;
      try {
        const metadataPath = typeof node.metadata?.file_path === "string" ? node.metadata.file_path : null;
        if (metadataPath && metadataPath.trim()) {
          filePath = path.isAbsolute(metadataPath)
            ? metadataPath
            : path.join(workspaceRoot, metadataPath);
        } else {
          filePath = getNodeFilePath(node, workspace);
        }
      } catch {
        filePath = null;
      }
      const relativeFile =
        filePath && workspaceRoot ? path.relative(workspaceRoot, filePath) : filePath;

      return {
        name: stepName,
        node_id: nodeId,
        label: node.label,
        status: node.isDraft ? "draft" as const : "finalized" as const,
        is_current: stepName === workflow.current_step,
        file_path: relativeFile ?? filePath ?? null,
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return {
      workflow,
      steps,
    };
  }
}

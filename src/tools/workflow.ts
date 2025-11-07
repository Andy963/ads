import path from "node:path";
import { promises as fs } from "node:fs";

import {
  getAllWorkflowTemplates,
  getWorkflowTemplate,
  getNodeTypeConfig as fetchNodeTypeConfig,
} from "../graph/workflowConfig.js";
import { createWorkflowFromConfig, WorkflowNodeConfig } from "../graph/autoWorkflow.js";
import { detectWorkspace, getWorkspaceSpecsDir } from "../workspace/detector.js";
import { WorkflowContext } from "../workspace/context.js";
import { listRules } from "./rules.js";
import { safeStringify } from "../utils/json.js";
import { saveNodeToFile } from "../graph/fileManager.js";

export async function listWorkflowTemplates(): Promise<string> {
  try {
    const templates = getAllWorkflowTemplates();
    const result = Object.entries(templates).map(([templateId, template]) => ({
      id: templateId,
      name: template.name ?? templateId,
      description: template.description ?? "",
      steps: Array.isArray(template.steps) ? template.steps.length : 0,
    }));

    return safeStringify({ templates: result });
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}

export async function getWorkflowTemplateDetails(templateId: string): Promise<string> {
  try {
    const template = getWorkflowTemplate(templateId);
    if (!template) {
      return safeStringify({
        error: `模板不存在: ${templateId}`,
      });
    }

    return safeStringify(template);
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}

export async function getNodeTypeConfig(nodeType: string): Promise<string> {
  try {
    const config = fetchNodeTypeConfig(nodeType);
    if (!config) {
      return safeStringify({ error: `节点类型不存在: ${nodeType}` });
    }
    return safeStringify(config);
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}

async function getRulesSummary(workspacePath: string): Promise<string> {
  try {
    const rulesJson = await listRules({ workspace_path: workspacePath });
    const parsed = JSON.parse(rulesJson) as { rules?: Array<{ title?: string }> };
    if (!parsed.rules || parsed.rules.length === 0) {
      return "";
    }
    const critical = parsed.rules.slice(0, 5).map((rule) => `- ${rule.title ?? ""}`).join("\n");
    if (!critical) {
      return "";
    }
    return `⚠️ **严格禁止规则（违反任一条立即停止）**\n${critical}`;
  } catch {
    return "";
  }
}

export async function createWorkflowFromTemplate(params: {
  template_id: string;
  title: string;
  description?: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const template = getWorkflowTemplate(params.template_id);
    if (!template) {
      return safeStringify({
        error: `工作流模板不存在: ${params.template_id}`,
        available_templates: Object.keys(getAllWorkflowTemplates()),
      });
    }

    const nodesConfig: WorkflowNodeConfig[] = [];
    for (const step of template.steps ?? []) {
      const defaultOption = step.default_option;
      const option = defaultOption
        ? step.options?.find((opt) => opt.node_type === defaultOption)
        : step.options?.[0];
      if (option && step.required) {
        nodesConfig.push({
          node_type: option.node_type,
          label_suffix: option.label,
          required: step.required,
        });
      }
    }

    if (nodesConfig.length === 0) {
      return safeStringify({ error: "模板没有可用的必需步骤" });
    }

    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();

    let enhancedDescription = params.description ?? "";
    if (enhancedDescription) {
      enhancedDescription += "\n\n---\n\n";
    }
    const rulesSummary = await getRulesSummary(workspace);
    if (rulesSummary) {
      enhancedDescription += `## 项目规则约束\n\n${rulesSummary}\n\n---\n\n`;
    }

    const result = createWorkflowFromConfig({
      nodes: nodesConfig.slice(0, 1),
      rootLabel: params.title,
      rootContent: enhancedDescription,
      position: { x: 100, y: 100 },
    });

    const rootNode = result.nodes[0];
    const specsDir = getWorkspaceSpecsDir(workspace);
    const workflowDir = path.join(specsDir, rootNode.id);
    await fs.mkdir(workflowDir, { recursive: true });

    for (const node of result.nodes) {
      saveNodeToFile(node, workspace);
    }

    // 设置为活动工作流
    try {
      const stepMapping = WorkflowContext.STEP_MAPPINGS[params.template_id] ?? {};
      const steps: Record<string, string> = {};

      // 构建步骤映射
      for (const [stepName, nodeType] of Object.entries(stepMapping)) {
        const node = result.nodes.find((n) => n.type === nodeType);
        if (node) {
          steps[stepName] = node.id;
        }
      }

      WorkflowContext.setActiveWorkflow({
        workspace,
        workflowRootId: rootNode.id,
        template: params.template_id,
        title: params.title,
        steps,
      });
    } catch (error) {
      console.warn("Warning: Failed to set active workflow:", error);
    }

    return safeStringify({
      success: true,
      workflow: {
        root_node_id: rootNode.id,
        nodes_created: result.nodes.length,
        edges_created: result.edges.length,
      },
      message: "工作流已创建，后续步骤将通过定稿自动流转",
    });
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}

import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  getAllWorkflowTemplates,
  getWorkflowTemplate,
  getNodeTypeConfig as fetchNodeTypeConfig,
} from "../graph/workflowConfig.js";
import { createWorkflowFromConfig, type WorkflowNodeConfig } from "../graph/autoWorkflow.js";
import { updateNode } from "../graph/crud.js";
import { detectWorkspace, getWorkspaceSpecsDir } from "../workspace/detector.js";
import { WorkflowContext } from "../workspace/context.js";
import { listRules } from "../workspace/rulesService.js";
import { safeStringify } from "../utils/json.js";
import { saveNodeToFile } from "../graph/fileManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_ROOT = path.join(PROJECT_ROOT, "templates");
const REQUIREMENT_TEMPLATE = path.join(TEMPLATE_ROOT, "requirement.md");
const DESIGN_TEMPLATE = path.join(TEMPLATE_ROOT, "design.md");
const IMPLEMENTATION_TEMPLATE = path.join(TEMPLATE_ROOT, "implementation.md");

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

function sanitizeSlug(title: string | undefined | null): string {
  if (!title) {
    return "workflow";
  }
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "workflow";
}

async function writeTemplateFile(targetDir: string, filename: string, templatePath: string): Promise<void> {
  try {
    const content = await fs.readFile(templatePath, "utf-8");
    const targetPath = path.join(targetDir, filename);
    await fs.writeFile(targetPath, content, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
}

export async function createWorkflowFromTemplate(params: {
  template_id?: string;
  title: string;
  description?: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const requestedId = params.template_id?.trim();
    const normalizedId = requestedId ? requestedId.toLowerCase() : "unified";
    const template = getWorkflowTemplate(normalizedId);
    if (!template) {
      return safeStringify({
        error: `工作流模板不存在: ${params.template_id ?? ""}`,
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
    const now = new Date();
    const folderTimestamp = `${now.getFullYear()}${(now.getMonth() + 1)
      .toString()
      .padStart(2, "0")}${now.getDate().toString().padStart(2, "0")}-${now
      .getHours()
      .toString()
      .padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}`;
    const slug = sanitizeSlug(params.title);
    let folderName = `${folderTimestamp}-${slug}`;
    let workflowDir = path.join(specsDir, folderName);
    let attempt = 1;
    while (true) {
      try {
        await fs.mkdir(workflowDir, { recursive: false });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }
        attempt += 1;
        folderName = `${folderTimestamp}-${slug}-${attempt}`;
        workflowDir = path.join(specsDir, folderName);
      }
    }

    const rootMetadata = {
      ...(rootNode.metadata ?? {}),
      workflow_template: normalizedId,
      spec_folder: folderName,
    };
    updateNode(rootNode.id, { metadata: rootMetadata });

    await writeTemplateFile(workflowDir, "requirements.md", REQUIREMENT_TEMPLATE);
    await writeTemplateFile(workflowDir, "design.md", DESIGN_TEMPLATE);
    await writeTemplateFile(workflowDir, "implementation.md", IMPLEMENTATION_TEMPLATE);

    for (const node of result.nodes) {
      saveNodeToFile(node, workspace);
    }

    // 设置为活动工作流
    try {
      const normalizedStepMapping = WorkflowContext.STEP_MAPPINGS[normalizedId] ?? {};
      const steps: Record<string, string> = {};

      for (const [stepName, nodeType] of Object.entries(normalizedStepMapping)) {
        const node = result.nodes.find((n) => n.type === nodeType);
        if (node) {
          steps[stepName] = node.id;
        }
      }

      WorkflowContext.setActiveWorkflow({
        workspace,
        workflowRootId: rootNode.id,
        template: normalizedId,
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

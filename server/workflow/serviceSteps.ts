import fs from "node:fs";
import path from "node:path";

import { WorkflowContext } from "../workspace/context.js";
import { resolveWorkspaceRoot } from "../workspace/detector.js";
import { getNodeById, updateNode } from "../graph/crud.js";
import { finalizeNode } from "../graph/finalizeHelper.js";
import { onNodeFinalized } from "../graph/autoWorkflow.js";
import { saveNodeToFile, getSpecDir } from "../graph/fileManager.js";
import type { GraphNode } from "../graph/types.js";
import { escapeTelegramInlineCode, escapeTelegramMarkdown } from "../utils/markdown.js";

import type { WorkflowTextFormat } from "./formatter.js";
import { getWorkflowStatusSummary } from "./serviceSummary.js";
import { recordWorkflowCommit } from "./serviceCommitLog.js";
import { withWorkspaceEnv } from "./serviceWorkspace.js";

export async function getStepNode(params: { step_name: string; workspace_path?: string }): Promise<string> {
  const workspace = resolveWorkspaceRoot(params.workspace_path);
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return "❌ 没有活动的工作流";
  }

  const nodeId = WorkflowContext.getWorkflowStepNodeId(params.step_name, workflow, workspace);
  if (!nodeId) {
    const available = Object.keys(workflow.steps ?? {}).join(", ");
    return `❌ 步骤 '${params.step_name}' 不存在\n\n可用步骤: ${available}`;
  }

  const node = getNodeById(nodeId);
  if (!node) {
    return `❌ 节点 ${nodeId} 不存在`;
  }

  return [
    `### ${node.label}`,
    "",
    `ID: ${node.id}`,
    `Type: ${node.type}`,
    `Status: ${node.isDraft ? "draft" : "finalized"}`,
    "",
    node.content ?? "(暂无内容)",
  ].join("\n");
}

export async function addStepDraft(params: { step_name: string; content: string; workspace_path?: string }): Promise<string> {
  const workspace = resolveWorkspaceRoot(params.workspace_path);
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return "❌ 没有活动的工作流";
  }

  const nodeId = WorkflowContext.getWorkflowStepNodeId(params.step_name, workflow, workspace);
  if (!nodeId) {
    return `❌ 步骤 '${params.step_name}' 不存在`;
  }

  const node = updateNode(nodeId, {
    draft_content: params.content,
    is_draft: true,
    draft_updated_at: new Date().toISOString(),
  });

  if (!node) {
    return `❌ 节点 ${nodeId} 更新失败`;
  }

  WorkflowContext.updateCurrentStep(params.step_name, workspace);

  return [`📝 Updated draft for '${params.step_name}'`, "", params.content].join("\n");
}

export async function commitStep(params: {
  step_name: string;
  change_description?: string;
  workspace_path?: string;
  format?: WorkflowTextFormat;
}): Promise<string> {
  const workspace = resolveWorkspaceRoot(params.workspace_path);
  return withWorkspaceEnv(workspace, async () => {
    const workflow = WorkflowContext.getActiveWorkflow(workspace);
    if (!workflow) {
      return "❌ 没有活动的工作流";
    }

    const nodeId = WorkflowContext.getWorkflowStepNodeId(params.step_name, workflow, workspace);
    if (!nodeId) {
      return `❌ 步骤 '${params.step_name}' 不存在`;
    }

    const node = getNodeById(nodeId);
    if (!node) {
      return `❌ 节点 ${nodeId} 不存在`;
    }

    const specDir = getSpecDir(node, workspace);
    const workflowSteps = WorkflowContext.STEP_MAPPINGS[workflow.template ?? ""] ?? {};
    const normalizedStepName = Object.entries(workflowSteps).find(([, value]) => value === node.type)?.[0] ?? params.step_name;
    const candidateFiles = [
      `${normalizedStepName}.md`,
      `${params.step_name}.md`,
      `${node.type}.md`,
      "requirements.md",
      "design.md",
      "implementation.md",
    ];

    let specContent: string | null = null;
    for (const fileName of candidateFiles) {
      const filePath = path.join(specDir, fileName);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        specContent = raw.trim();
        if (specContent) {
          break;
        }
      }
    }

    if (!specContent || !specContent.trim()) {
      return `❌ 定稿失败: 未在 ${path.relative(workspace, specDir)} 找到 ${params.step_name} 的内容，请填写 spec 后再试`;
    }

    updateNode(nodeId, {
      draft_content: specContent,
      is_draft: true,
      draft_updated_at: new Date().toISOString(),
      draft_source_type: "spec-file",
    });

    let finalizedNode: GraphNode;
    try {
      finalizedNode = await finalizeNode(nodeId, params.change_description);
    } catch (error) {
      return `❌ 定稿失败: ${(error as Error).message}`;
    }

    const filePath = saveNodeToFile(finalizedNode, workspace);

    const workflowResult = onNodeFinalized(nodeId);
    let nextStepMessage = "";
    let nextStepName: string | null = null;

    if (workflowResult?.node_id) {
      const stepMapping = WorkflowContext.STEP_MAPPINGS[workflow.template ?? ""] ?? {};
      const nextNode = getNodeById(workflowResult.node_id);
      if (nextNode) {
        const entry = Object.entries(stepMapping).find(([, nodeType]) => nodeType === nextNode.type);
        if (entry) {
          WorkflowContext.addWorkflowStep(entry[0], nextNode.id, workspace);
          nextStepName = entry[0];
          nextStepMessage = `\n➡️ 下一步: ${entry[0]} (${nextNode.label})`;
        }
      }
    }

    const currentStep = nextStepName ?? params.step_name;
    WorkflowContext.updateCurrentStep(currentStep, workspace);

    const workflowListEntry = WorkflowContext.listAllWorkflows(workspace).find((wf) => wf.workflow_id === workflow.workflow_id);
    const templateId =
      workflow.template ??
      (workflowListEntry?.template ?? null) ??
      (finalizedNode.metadata && typeof finalizedNode.metadata === "object"
        ? (finalizedNode.metadata as Record<string, unknown>).workflow_template
        : null);

    recordWorkflowCommit({
      workflow_id: workflow.workflow_id,
      workflow_title: workflow.title ?? null,
      template: templateId ? String(templateId) : null,
      node_id: finalizedNode.id,
      step_name: params.step_name,
      node_label: finalizedNode.label,
      version: finalizedNode.currentVersion ?? 1,
      change_description: params.change_description ?? null,
      file_path: filePath ?? null,
      created_at: new Date().toISOString(),
    });

    const format = params.format ?? "cli";
    const isMarkdown = format === "markdown";
    const escapeText = (text: string) => (isMarkdown ? escapeTelegramMarkdown(text) : text);
    const inlineCode = (text: string) => (isMarkdown ? `\`${escapeTelegramInlineCode(text)}\`` : text);

    const lines: string[] = [];
    lines.push(`✅ Committed ${inlineCode(params.step_name)} as v${finalizedNode.currentVersion}`);
    if (filePath) {
      lines.push(`📁 Saved to: ${inlineCode(filePath)}`);
    }
    if (workflowResult?.message) {
      lines.push(escapeText(workflowResult.message));
    }
    if (nextStepMessage) {
      lines.push(escapeText(nextStepMessage));
    }

    const statusSummary = await getWorkflowStatusSummary({
      workspace_path: workspace,
      format,
    });
    lines.push("");
    lines.push(statusSummary);

    return lines.join("\n");
  });
}

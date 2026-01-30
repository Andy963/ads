import path from "node:path";

import { WorkflowContext } from "../workspace/context.js";
import { detectWorkspace } from "../workspace/detector.js";
import { loadVectorSearchConfig } from "../vectorSearch/config.js";

import { formatWorkflowStatusSummary, type WorkflowTextFormat } from "./formatter.js";

const CMD_NEW = "/ads.new";
const CMD_STATUS = "/ads.status";
const CMD_BRANCH = "/ads.branch";
const CMD_CHECKOUT = "/ads.checkout";
const CMD_COMMIT = "/ads.commit";

export async function getActiveWorkflowSummary(params: { workspace_path?: string }): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return [
      "❌ 没有活动的工作流",
      "",
      "💡 开始使用：",
      `    - 创建新工作流: ${CMD_NEW} <title> [--template_id=<unified|adhoc>]`,
      `    - 查看所有工作流: ${CMD_BRANCH}`,
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("```");
  lines.push("✓ 当前工作流:");
  lines.push(`    标题: ${workflow.title ?? "（未命名）"}`);
  lines.push(`    模板: ${workflow.template ?? "unknown"}`);
  lines.push(`    ID: ${workflow.workflow_id}`);
  if (workflow.current_step) {
    lines.push(`    当前步骤: ${workflow.current_step}`);
  }
  const steps = workflow.steps ?? {};
  const stepNames = Object.keys(steps);
  if (stepNames.length > 0) {
    lines.push("");
    lines.push(`    步骤（共 ${stepNames.length} 个）:`);
    for (const stepName of stepNames) {
      lines.push(`        - ${stepName}: ${steps[stepName] ?? "(未创建)"}`);
    }
  }
  lines.push("");
  lines.push(`💡 查看详细状态请用: ${CMD_STATUS}`);
  lines.push("```");
  return lines.join("\n");
}

export async function getWorkflowStatusSummary(params: { workspace_path?: string; format?: WorkflowTextFormat }): Promise<string> {
  const format = params.format ?? "cli";
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflowStatus = WorkflowContext.getWorkflowStatus(workspace);
  if (!workflowStatus) {
    if (format === "markdown") {
      return [
        "**❌ 没有活动的工作流**",
        "",
        "💡 开始使用：",
        `- 使用 \`${CMD_BRANCH}\` 查看现有工作流`,
        `- 使用 \`${CMD_NEW}\` 创建新工作流`,
        `- 使用 \`${CMD_CHECKOUT} <workflow>\` 切换到指定工作流`,
      ].join("\n");
    }
    return [
      "❌ 没有活动的工作流",
      "",
      `💡 开始使用：`,
      `    - 查看现有工作流: ${CMD_BRANCH}`,
      `    - 创建新工作流: ${CMD_NEW} <title> [--template_id=<unified|adhoc>]`,
      `    - 切换到工作流: ${CMD_CHECKOUT} <workflow>`,
    ].join("\n");
  }

  const workflow = workflowStatus.workflow;
  const steps = workflowStatus.steps ?? [];

  const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
  const stepMapping = WorkflowContext.STEP_MAPPINGS[workflow.template ?? ""] ?? {};
  const stepOrder = Object.keys(stepMapping);
  const nextActions: Array<{ label: string; command: string }> = [{ label: "完成步骤", command: `${CMD_COMMIT} <step>` }];

  return formatWorkflowStatusSummary(
    {
      workflow,
      steps,
      stepOrder,
      allWorkflows,
      nextActions,
    },
    { format },
  );
}

export function workflowSummaryWantsVectorSearchGuide(): boolean {
  const { config } = loadVectorSearchConfig();
  return !!config?.enabled;
}


import path from "node:path";

import { WorkflowContext } from "../workspace/context.js";
import { detectWorkspace } from "../workspace/detector.js";

import { formatWorkflowStatusSummary, type WorkflowTextFormat } from "./formatter.js";

export async function getActiveWorkflowSummary(params: { workspace_path?: string }): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return [
      "❌ 没有活动的工作流",
      "",
      "💡 开始使用：",
      "    - 在 Web UI 或通过 skills 创建新工作流",
      "    - 在 Web UI 中查看所有工作流",
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
  lines.push("💡 查看详细状态请在 Web UI 中打开工作流面板。");
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
        "- 在 Web UI 或通过 skills 创建新工作流",
        "- 在 Web UI 中查看/切换工作流",
      ].join("\n");
    }
    return [
      "❌ 没有活动的工作流",
      "",
      `💡 开始使用：`,
      "    - 在 Web UI 或通过 skills 创建新工作流",
      "    - 在 Web UI 中查看/切换工作流",
    ].join("\n");
  }

  const workflow = workflowStatus.workflow;
  const steps = workflowStatus.steps ?? [];

  const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
  const stepMapping = WorkflowContext.STEP_MAPPINGS[workflow.template ?? ""] ?? {};
  const stepOrder = Object.keys(stepMapping);
  const nextActions: Array<{ label: string; command: string }> = [{ label: "完成步骤（通过 Web UI 或 skills）", command: "" }];

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

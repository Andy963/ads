import path from "node:path";

import { WorkflowContext } from "../workspace/context.js";
import { detectWorkspace } from "../workspace/detector.js";
import { getNodeById, updateNode, deleteNode } from "../graph/crud.js";
import { finalizeNode } from "../graph/finalizeHelper.js";
import { onNodeFinalized } from "../graph/autoWorkflow.js";
import { saveNodeToFile } from "../graph/fileManager.js";
import type { GraphNode } from "../graph/types.js";
import { getDatabase } from "../storage/database.js";

const CMD_NEW = "/ads.new";
const CMD_STATUS = "/ads.status";
const CMD_BRANCH = "/ads.branch";
const CMD_CHECKOUT = "/ads.checkout";
const CMD_ADD = "/ads.add";
const CMD_COMMIT = "/ads.commit";

export async function getActiveWorkflowSummary(params: {
  workspace_path?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return [
      "❌ 没有活动的工作流",
      "",
      "💡 开始使用：",
      `    - 创建新工作流: ${CMD_NEW} <type> <title>`,
      `    - 查看所有工作流: ${CMD_BRANCH}`,
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("```");
  lines.push("✓ Active workflow:");
  lines.push(`    Title: ${workflow.title ?? "Unknown"}`);
  lines.push(`    Template: ${workflow.template ?? "Unknown"}`);
  lines.push(`    ID: ${workflow.workflow_id}`);
  if (workflow.current_step) {
    lines.push(`    Current step: ${workflow.current_step}`);
  }
  const steps = workflow.steps ?? {};
  const stepNames = Object.keys(steps);
  if (stepNames.length > 0) {
    lines.push("");
    lines.push(`    Steps (${stepNames.length} total):`);
    for (const stepName of stepNames) {
      lines.push(`        - ${stepName}: ${steps[stepName] ?? "(not created)"}`);
    }
  }
  lines.push("");
  lines.push(`💡 For detailed status, use: ${CMD_STATUS}`);
  lines.push("```");
  return lines.join("\n");
}

export async function getWorkflowStatusSummary(params: {
  workspace_path?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflowStatus = WorkflowContext.getWorkflowStatus(workspace);
  if (!workflowStatus) {
    return [
      "❌ No active workflow",
      "",
      `💡 To get started:`,
      `    - List existing workflows: ${CMD_BRANCH}`,
      `    - Create new workflow: ${CMD_NEW} <type> <title>`,
      `    - Switch to workflow: ${CMD_CHECKOUT} <workflow>`,
    ].join("\n");
  }

  const workflow = workflowStatus.workflow;
  const steps = workflowStatus.steps ?? [];

  const lines: string[] = [];
  lines.push(`On workflow: ${workflow.title ?? "Unknown"}`);
  lines.push(`Template: ${workflow.template ?? "Unknown"}`);
  if (workflow.workflow_id) {
    lines.push(`ID: ${workflow.workflow_id}`);
  }
  lines.push("");
  lines.push("Steps:");

  const stepMapping = WorkflowContext.STEP_MAPPINGS[workflow.template ?? ""] ?? {};
  const stepOrder = Object.keys(stepMapping);

  let finalizedCount = 0;
  for (const stepName of stepOrder) {
    const info = steps.find((step) => step.name === stepName);
    if (!info) {
      lines.push(`  ○ ${stepName} (not created)`);
      continue;
    }
    const statusIcon = info.status === "finalized" ? "✅" : "📝";
    if (info.status === "finalized") {
      finalizedCount += 1;
    }
    const currentMark = info.is_current ? " ← current" : "";
    lines.push(`  ${statusIcon} ${stepName}: ${info.label}${currentMark}`);
  }

  const progress = stepOrder.length > 0 ? Math.round((finalizedCount / stepOrder.length) * 100) : 0;
  lines.push("");
  lines.push(`Progress: ${progress}% (${finalizedCount}/${stepOrder.length})`);

  if (progress === 100) {
    lines.push("");
    lines.push("🎉 This workflow is complete!");
  }

  lines.push("");
  lines.push("💡 Next actions:");
  lines.push(`    - Add draft content: ${CMD_ADD} <step> <content>`);
  lines.push(`    - Finalize step: ${CMD_COMMIT} <step>`);

  return lines.join("\n");
}

export async function listWorkflows(params: {
  workspace_path?: string;
  operation?: "list" | "delete" | "force_delete";
  workflow?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();

  // 处理删除操作
  if (params.operation === "delete" || params.operation === "force_delete") {
    if (!params.workflow) {
      return "❌ 请指定要删除的工作流（序号、标题或 ID）";
    }

    const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
    if (allWorkflows.length === 0) {
      return "没有找到任何工作流";
    }

    // 查找工作流（支持序号、标题、ID）
    let targetWorkflow = null;
    const index = parseInt(params.workflow, 10);
    if (!isNaN(index) && index >= 1 && index <= allWorkflows.length) {
      targetWorkflow = allWorkflows[index - 1];
    } else {
      targetWorkflow = allWorkflows.find((wf) => wf.workflow_id === params.workflow);
      if (!targetWorkflow) {
        targetWorkflow = allWorkflows.find((wf) => wf.title === params.workflow);
      }
      if (!targetWorkflow) {
        targetWorkflow = allWorkflows.find((wf) =>
          wf.title.toLowerCase().includes(params.workflow!.toLowerCase()),
        );
      }
    }

    if (!targetWorkflow) {
      return `❌ 未找到匹配 '${params.workflow}' 的工作流`;
    }

    // 删除工作流
    // 1. 删除上下文中的记录
    const context = WorkflowContext.loadContext(workspace);
    const hadContext = Boolean(context.workflows[targetWorkflow.workflow_id]);
    delete context.workflows[targetWorkflow.workflow_id];
    if (context.active_workflow_id === targetWorkflow.workflow_id) {
      context.active_workflow_id = null;
      context.active_workflow = null;
    }
    WorkflowContext.saveContext(workspace, context);

    // 2. 删除数据库中的所有节点（force_delete）
    if (params.operation === "force_delete") {
      const workflowNodes = WorkflowContext.collectWorkflowNodes(targetWorkflow.workflow_id);
      const nodeIds = new Set(workflowNodes.map((node) => node.id));
      nodeIds.add(targetWorkflow.workflow_id);

      const db = getDatabase();
      let edgesRemoved = 0;
      for (const nodeId of nodeIds) {
        const result = db.prepare("DELETE FROM edges WHERE source = ? OR target = ?").run(nodeId, nodeId);
        edgesRemoved += result?.changes ?? 0;
      }

      let nodesRemoved = 0;
      for (const nodeId of nodeIds) {
        if (deleteNode(nodeId)) {
          nodesRemoved += 1;
        }
      }

      const orphanCount = Math.max(nodeIds.size - 1, 0);
      const lines = [
        `✅ 已彻底删除工作流: ${targetWorkflow.title} (${targetWorkflow.workflow_id})`,
        `🧹 清理节点 ${nodesRemoved}/${nodeIds.size} 个（含孤立节点 ${orphanCount} 个），移除关联边 ${edgesRemoved} 条`,
      ];
      if (!hadContext) {
        lines.push("⚠️ 工作流上下文原本不存在，已直接清理数据库记录");
      }
      return lines.join("\n");
    }

    return `✅ 已删除工作流上下文: ${targetWorkflow.title} (${targetWorkflow.workflow_id})\n💡 节点数据已保留（使用 -D 或 --delete 可彻底删除）`;
  }

  // 列出工作流
  const workflows = WorkflowContext.listAllWorkflows(workspace);
  if (workflows.length === 0) {
    return "没有找到任何工作流。使用 /ads.new 创建一个新的工作流。";
  }

  const lines: string[] = [];
  lines.push("现有工作流：");
  workflows.forEach((wf, index) => {
    lines.push(
      `${index + 1}. [${wf.template}] ${wf.title} (nodes: ${wf.node_count}, finalized: ${wf.finalized_count}) - ${wf.workflow_id}`,
    );
  });
  return lines.join("\n");
}

export async function listWorkflowLog(params: {
  workspace_path?: string;
  limit?: number;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflows = WorkflowContext.listAllWorkflows(workspace).slice(0, params.limit ?? 5);
  if (workflows.length === 0) {
    return "No workflows found.";
  }
  const lines: string[] = [];
  lines.push("Recent workflows:");
  workflows.forEach((wf) => {
    lines.push(
      `- ${wf.title} [${wf.template}] nodes=${wf.node_count} finalized=${wf.finalized_count} id=${wf.workflow_id}`,
    );
  });
  return lines.join("\n");
}

export async function checkoutWorkflow(params: {
  workflow_identifier: string;
  workspace_path?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const result = WorkflowContext.switchWorkflow(params.workflow_identifier, workspace);
  if (!result.success) {
    if (result.matches && result.matches.length > 1) {
      const suggestions = result.matches
        .map((match: any) => `- ${match.title} (${match.workflow_id})`)
        .join("\n");
      return `${result.message}\n${suggestions}`;
    }
    return result.message;
  }
  return result.message;
}

export async function getStepNode(params: {
  step_name: string;
  workspace_path?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
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

export async function addStepDraft(params: {
  step_name: string;
  content: string;
  workspace_path?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
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

  return [
    `📝 Updated draft for '${params.step_name}'`,
    "",
    params.content,
  ].join("\n");
}

export async function commitStep(params: {
  step_name: string;
  change_description?: string;
  workspace_path?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return "❌ 没有活动的工作流";
  }

  const nodeId = WorkflowContext.getWorkflowStepNodeId(params.step_name, workflow, workspace);
  if (!nodeId) {
    return `❌ 步骤 '${params.step_name}' 不存在`;
  }

  let finalizedNode: GraphNode;
  try {
    finalizedNode = await finalizeNode(nodeId, params.change_description);
  } catch (error) {
    return `❌ 定稿失败: ${(error as Error).message}`;
  }

  const filePath = saveNodeToFile(finalizedNode, workspace);

  const workflowResult = onNodeFinalized(nodeId);
  let nextStepMessage = "";

  if (workflowResult?.node_id) {
    const stepMapping = WorkflowContext.STEP_MAPPINGS[workflow.template ?? ""] ?? {};
    const nextNode = getNodeById(workflowResult.node_id);
    if (nextNode) {
      const entry = Object.entries(stepMapping).find(([, nodeType]) => nodeType === nextNode.type);
      if (entry) {
        WorkflowContext.addWorkflowStep(entry[0], nextNode.id, workspace);
        nextStepMessage = `\n➡️ 下一步: ${entry[0]} (${nextNode.label})`;
      }
    }
  }

  WorkflowContext.updateCurrentStep(params.step_name, workspace);

  const lines: string[] = [];
  lines.push(`✅ Committed '${params.step_name}' as v${finalizedNode.currentVersion}`);
  if (filePath) {
    lines.push(`📁 Saved to: ${filePath}`);
  }
  if (workflowResult?.message) {
    lines.push(workflowResult.message);
  }
  if (nextStepMessage) {
    lines.push(nextStepMessage);
  }
  return lines.join("\n");
}

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

interface WorkflowCommitRecord {
  workflow_id: string;
  workflow_title?: string | null;
  template?: string | null;
  node_id: string;
  step_name: string;
  node_label?: string | null;
  version: number;
  change_description?: string | null;
  file_path?: string | null;
  created_at: string;
}

interface WorkflowCommitRow extends WorkflowCommitRecord {}

function recordWorkflowCommit(record: WorkflowCommitRecord): void {
  if (!record.workflow_id) {
    return;
  }
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO workflow_commits (
      workflow_id,
      workflow_title,
      template,
      node_id,
      step_name,
      node_label,
      version,
      change_description,
      file_path,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    record.workflow_id,
    record.workflow_title ?? null,
    record.template ?? null,
    record.node_id,
    record.step_name,
    record.node_label ?? null,
    record.version,
    record.change_description ?? null,
    record.file_path ?? null,
    record.created_at
  );
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  const allWorkflows = WorkflowContext.listAllWorkflows(workspace);

  const lines: string[] = [];
  const COLOR_RESET = "\u001b[0m";
  const COLOR_ACTIVE = "\u001b[32m";
  const COLOR_INACTIVE = "\u001b[90m";

  const activeHeader = `${COLOR_ACTIVE}${workflow.workflow_id ?? "(unknown-id)"} • ${workflow.title ?? "Unknown"}${COLOR_RESET}`;
  lines.push("当前工作流:");
  lines.push(`  ${activeHeader}`);
  lines.push(`  模板: ${workflow.template ?? "Unknown"}`);
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

  if (allWorkflows.length > 0) {
    lines.push("");
    lines.push("所有工作流:");
    for (const wf of allWorkflows) {
      const isCurrent = wf.workflow_id === workflow.workflow_id;
      const color = isCurrent ? COLOR_ACTIVE : COLOR_INACTIVE;
      const label = `${wf.workflow_id} ${wf.title ?? "(未命名)"} [${wf.template ?? "unknown"}] nodes:${wf.node_count} finalized:${wf.finalized_count}`;
      lines.push(`  ${color}${isCurrent ? "★ " : "  "}${label}${COLOR_RESET}`);
    }
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
        const matches = allWorkflows.filter((wf) =>
          wf.workflow_id.toLowerCase().startsWith(params.workflow!.toLowerCase()),
        );
        if (matches.length === 1) {
          targetWorkflow = matches[0];
        } else if (matches.length > 1) {
          const preview = matches
            .slice(0, 5)
            .map((wf) => `  ${wf.workflow_id} ${wf.title ?? "(未命名)"}`)
            .join("\n");
          const tail = matches.length > 5 ? "\n  …" : "";
          return [`❌ 前缀 '${params.workflow}' 匹配多个工作流:`, preview + tail, "请提供更长的 ID 前缀"].join("\n");
        }
      }
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

    return `✅ 已删除工作流上下文: ${targetWorkflow.title} (${targetWorkflow.workflow_id})\n💡 节点数据已保留（使用 -D 或 --delete 可彻底删除)`;
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
  workflow?: string;
}): Promise<string> {
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const db = getDatabase();
  const limit = params.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;

  const activeWorkflow = WorkflowContext.getActiveWorkflow(workspace);
  const activeId = activeWorkflow?.workflow_id ?? null;

  let workflowId: string | null = null;
  let workflowTitle: string | null = null;

  const requestFilter = params.workflow?.trim();
  if (requestFilter) {
    const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
    const direct = allWorkflows.find((wf) => wf.workflow_id === requestFilter);
    if (direct) {
      workflowId = direct.workflow_id;
      workflowTitle = direct.title ?? null;
    } else {
      const exactByTitle = allWorkflows.find((wf) => wf.title === requestFilter);
      if (exactByTitle) {
        workflowId = exactByTitle.workflow_id;
        workflowTitle = exactByTitle.title ?? null;
      }
    }

    if (!workflowId) {
      const matches = db
        .prepare("SELECT DISTINCT workflow_id FROM workflow_commits WHERE workflow_id LIKE ?")
        .all(`${requestFilter}%`) as Array<{ workflow_id: string }>;

      if (matches.length === 0) {
        return `❌ 未找到匹配 '${requestFilter}' 的提交记录`;
      }
      if (matches.length > 1) {
        const preview = matches
          .slice(0, 5)
          .map((match) => `  ${match.workflow_id}`)
          .join("\n");
        const tail = matches.length > 5 ? "\n  …" : "";
        return [`❌ 前缀 '${requestFilter}' 匹配多个工作流:`, preview + tail, "请提供更长的 ID 前缀"].join("\n");
      }
      workflowId = matches[0].workflow_id;
    }
  } else if (activeId) {
    workflowId = activeId;
    workflowTitle = activeWorkflow?.title ?? null;
  }

  let rows: WorkflowCommitRow[] = [];
  if (workflowId) {
    rows = db
      .prepare(
        `SELECT workflow_id, workflow_title, template, node_id, step_name, node_label, version, change_description, file_path, created_at
         FROM workflow_commits
         WHERE workflow_id = ?
         ORDER BY datetime(created_at) DESC
         LIMIT ?`
      )
      .all(workflowId, limit) as WorkflowCommitRow[];
    if (!workflowTitle && rows.length > 0) {
      workflowTitle = rows[0].workflow_title ?? null;
    }
  } else {
    rows = db
      .prepare(
        `SELECT workflow_id, workflow_title, template, node_id, step_name, node_label, version, change_description, file_path, created_at
         FROM workflow_commits
         ORDER BY datetime(created_at) DESC
         LIMIT ?`
      )
      .all(limit) as WorkflowCommitRow[];
  }

  if (rows.length === 0) {
    if (workflowId) {
      return `该工作流暂无提交记录 (${workflowId}).`;
    }
    return "暂无任何提交记录。使用 /ads.commit 完成步骤时会生成日志。";
  }

  const COLOR_RESET = "\u001b[0m";
  const COLOR_ACTIVE = "\u001b[32m";
  const COLOR_INACTIVE = "\u001b[90m";

  const lines: string[] = [];
  if (workflowId) {
    const titleSegment = workflowTitle ? ` - ${workflowTitle}` : "";
    lines.push(`Workflow ${workflowId}${titleSegment} 的提交历史:`);
  } else {
    lines.push("最新提交:");
  }

  for (const row of rows) {
    const isActive = row.workflow_id === activeId;
    const color = isActive ? COLOR_ACTIVE : COLOR_INACTIVE;
    const star = isActive ? "★" : "•";
    const stepLabel = row.node_label && row.node_label !== row.step_name ? ` (${row.node_label})` : "";
    const titleHint = !workflowId && row.workflow_title ? ` ${row.workflow_title}` : "";
    const timestamp = formatTimestamp(row.created_at);
    lines.push(
      `${color}${star} ${row.workflow_id}${titleHint} v${row.version} ${row.step_name}${stepLabel} • ${timestamp}${COLOR_RESET}`
    );
    if (row.change_description) {
      lines.push(`    描述: ${row.change_description}`);
    }
    if (row.file_path) {
      lines.push(`    文件: ${row.file_path}`);
    }
  }

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

  const workflowListEntry = WorkflowContext.listAllWorkflows(workspace).find(
    (wf) => wf.workflow_id === workflow.workflow_id,
  );
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

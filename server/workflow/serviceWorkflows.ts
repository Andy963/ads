import { WorkflowContext } from "../workspace/context.js";
import { resolveWorkspaceRoot } from "../workspace/detector.js";
import { deleteNode } from "../graph/crud.js";
import { getDatabase } from "../storage/database.js";
import { escapeTelegramInlineCode, escapeTelegramMarkdown } from "../utils/markdown.js";

import { formatWorkflowList, type WorkflowTextFormat } from "./formatter.js";
import { withWorkspaceEnv } from "./serviceWorkspace.js";
import { getWorkflowStatusSummary } from "./serviceSummary.js";

export async function listWorkflows(params: {
  workspace_path?: string;
  operation?: "list" | "delete" | "force_delete";
  workflow?: string;
  format?: WorkflowTextFormat;
}): Promise<string> {
  const workspace = resolveWorkspaceRoot(params.workspace_path);
  const format = params.format ?? "cli";
  const markdown = format === "markdown";
  const escapeText = (value: string) => (markdown ? escapeTelegramMarkdown(value) : value);
  const inlineCode = (value: string) => (markdown ? `\`${escapeTelegramInlineCode(value)}\`` : value);
  const join = (lines: string[]) => lines.join("\n");

  if (params.operation === "delete" || params.operation === "force_delete") {
    if (!params.workflow) {
      return "❌ 请指定要删除的工作流（序号、标题或 ID）";
    }

    const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
    if (allWorkflows.length === 0) {
      return "没有找到任何工作流";
    }

    let targetWorkflow = null;
    const index = parseInt(params.workflow, 10);
    if (!isNaN(index) && index >= 1 && index <= allWorkflows.length) {
      targetWorkflow = allWorkflows[index - 1];
    } else {
      targetWorkflow = allWorkflows.find((wf) => wf.workflow_id === params.workflow);
      if (!targetWorkflow) {
        const matches = allWorkflows.filter((wf) => wf.workflow_id.toLowerCase().startsWith(params.workflow!.toLowerCase()));
        if (matches.length === 1) {
          targetWorkflow = matches[0];
        } else if (matches.length > 1) {
          const previewLines = matches
            .slice(0, 5)
            .map((wf) => (markdown ? `  - ${inlineCode(wf.workflow_id)}` : `  ${wf.workflow_id}`));
          const tail = matches.length > 5 ? (markdown ? "  - …" : "  …") : null;
          const body = tail ? [...previewLines, tail] : previewLines;
          return join([`❌ 前缀 '${escapeText(params.workflow)}' 匹配多个工作流:`, ...body, "请提供更长的 ID 前缀"]);
        }
      }
      if (!targetWorkflow) {
        targetWorkflow = allWorkflows.find((wf) => wf.title === params.workflow);
      }
      if (!targetWorkflow) {
        targetWorkflow = allWorkflows.find((wf) => wf.title.toLowerCase().includes(params.workflow!.toLowerCase()));
      }
    }

    if (!targetWorkflow) {
      return `❌ 未找到匹配 '${escapeText(params.workflow)}' 的工作流`;
    }

    const context = WorkflowContext.loadContext(workspace);
    const hadContext = Boolean(context.workflows[targetWorkflow.workflow_id]);
    delete context.workflows[targetWorkflow.workflow_id];
    if (context.active_workflow_id === targetWorkflow.workflow_id) {
      context.active_workflow_id = null;
      context.active_workflow = null;
    }
    WorkflowContext.saveContext(workspace, context);

    if (params.operation === "force_delete") {
      return await withWorkspaceEnv(workspace, async () => {
        const workflowNodes = WorkflowContext.collectWorkflowNodes(targetWorkflow.workflow_id, workspace);
        const nodeIds = new Set(workflowNodes.map((node) => node.id));
        nodeIds.add(targetWorkflow.workflow_id);

        const db = getDatabase(workspace);
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
          markdown
            ? `✅ 已彻底删除工作流: ${escapeText(targetWorkflow.title ?? "(未命名)")} (${inlineCode(targetWorkflow.workflow_id)})`
            : `✅ 已彻底删除工作流: ${targetWorkflow.title} (${targetWorkflow.workflow_id})`,
          `🧹 清理节点 ${nodesRemoved}/${nodeIds.size} 个（含孤立节点 ${orphanCount} 个），移除关联边 ${edgesRemoved} 条`,
        ];
        if (!hadContext) {
          lines.push(markdown ? "⚠️ 工作流上下文原本不存在，已直接清理数据库记录" : "⚠️ 工作流上下文原本不存在，已直接清理数据库记录");
        }
        return join(lines);
      });
    }

    const title = escapeText(targetWorkflow.title ?? "(未命名)");
    const workflowId = inlineCode(targetWorkflow.workflow_id);
    const message = markdown
      ? `✅ 已删除工作流上下文: ${title} (${workflowId})\n💡 节点数据已保留（使用 -D 或 --delete 可彻底删除)`
      : `✅ 已删除工作流上下文: ${targetWorkflow.title} (${targetWorkflow.workflow_id})\n💡 节点数据已保留（使用 -D 或 --delete 可彻底删除)`;
    return message;
  }

  const workflows = WorkflowContext.listAllWorkflows(workspace);
  return formatWorkflowList(workflows, { format });
}

export async function checkoutWorkflow(params: {
  workflow_identifier: string;
  workspace_path?: string;
  format?: WorkflowTextFormat;
}): Promise<string> {
  const workspace = resolveWorkspaceRoot(params.workspace_path);
  const result = WorkflowContext.switchWorkflow(params.workflow_identifier, workspace);
  if (!result.success) {
    if (result.matches && result.matches.length > 1) {
      const suggestions = result.matches.map((match) => `- ${match.title} (${match.workflow_id})`).join("\n");
      return `${result.message}\n${suggestions}`;
    }
    return result.message;
  }

  const format = params.format ?? "cli";
  const statusSummary = await getWorkflowStatusSummary({
    workspace_path: workspace,
    format,
  });

  return `${result.message}\n\n${statusSummary}`;
}

import path from "node:path";

import { WorkflowContext } from "../workspace/context.js";
import { detectWorkspace } from "../workspace/detector.js";
import { getDatabase } from "../storage/database.js";

import { formatWorkflowLog, type WorkflowTextFormat } from "./formatter.js";
import { withWorkspaceEnv } from "./serviceWorkspace.js";

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

type WorkflowCommitRow = WorkflowCommitRecord;

export function recordWorkflowCommit(record: WorkflowCommitRecord): void {
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

const DEFAULT_WORKFLOW_LOG_HEADER = "最新提交:";

export async function listWorkflowLog(params: {
  workspace_path?: string;
  limit?: number;
  workflow?: string;
  format?: WorkflowTextFormat;
}): Promise<string> {
  const format = params.format ?? "cli";
  const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
  const db = getDatabase(workspace);
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
  await withWorkspaceEnv(workspace, () => {
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
  });

  if (rows.length === 0) {
    if (workflowId) {
      return `该工作流暂无提交记录 (${workflowId}).`;
    }
    return "暂无任何提交记录。使用 /ads.commit 完成步骤时会生成日志。";
  }

  const entries = rows.map((row) => ({
    workflowId: row.workflow_id,
    workflowTitle: row.workflow_title,
    version: row.version,
    stepName: row.step_name,
    stepLabel: row.node_label,
    timestamp: formatTimestamp(row.created_at),
    changeDescription: row.change_description ?? null,
    filePath: row.file_path ?? null,
    isActive: row.workflow_id === activeId,
  }));

  const header = workflowId
    ? `Workflow ${workflowId}${workflowTitle ? ` - ${workflowTitle}` : ""} 的提交历史:`
    : DEFAULT_WORKFLOW_LOG_HEADER;

  return formatWorkflowLog(entries, {
    format,
    header,
    showWorkflowTitle: !workflowId,
  });
}


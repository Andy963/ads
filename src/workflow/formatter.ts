import pc from "picocolors";

import type { WorkflowInfo } from "../workspace/context.js";
import { escapeTelegramMarkdown, escapeTelegramInlineCode, escapeTelegramItalic } from "../utils/markdown.js";

export type WorkflowTextFormat = "cli" | "markdown";

interface WorkflowStepStatus {
  name: string;
  node_id: string;
  label: string;
  status: "draft" | "finalized";
  is_current: boolean;
  file_path?: string | null;
}

export interface WorkflowListEntry {
  workflow_id: string;
  template: string;
  title: string;
  node_count: number;
  finalized_count: number;
  created_at: string | null;
}

interface WorkflowStatusSummaryData {
  workflow: WorkflowInfo;
  steps: WorkflowStepStatus[];
  stepOrder: string[];
  allWorkflows: WorkflowListEntry[];
  nextActions: Array<{ label: string; command: string }>;
}

interface WorkflowLogEntry {
  workflowId: string;
  workflowTitle?: string | null;
  version: number;
  stepName: string;
  stepLabel?: string | null;
  timestamp: string;
  changeDescription?: string | null;
  filePath?: string | null;
  isActive: boolean;
}

interface WorkflowLogFormatOptions {
  format: WorkflowTextFormat;
  header: string;
  showWorkflowTitle?: boolean;
}

interface FormatHelpers {
  format: WorkflowTextFormat;
  escape: (text: string) => string;
  section: (title: string) => string;
  info: (text: string) => string;
  subInfo: (text: string) => string;
  code: (text: string) => string;
  muted: (text: string) => string;
  accent: (text: string) => string;
}

function createFormatHelpers(format: WorkflowTextFormat): FormatHelpers {
  // Markdown 输出用于展示，不使用 Telegram 特殊转义以避免破坏粗体等格式
  const escape = (text: string) => (format === "markdown" ? text : escapeTelegramMarkdown(text));
  const escapeCode = (text: string) => escapeTelegramInlineCode(text);
  const escapeItalic = (text: string) => escapeTelegramItalic(text);

  return {
    format,
    escape,
    section: (title: string) => {
      const escaped = escape(title);
      return format === "cli" ? `${title}:` : `**${escaped}**`;
    },
    info: (text: string) => (format === "cli" ? `  ${text}` : `- ${text}`),
    subInfo: (text: string) => (format === "cli" ? `    ${text}` : `  - ${text}`),
    code: (text: string) => (format === "cli" ? pc.cyan(text) : `\`${escapeCode(text)}\``),
    muted: (text: string) => (format === "cli" ? pc.dim(text) : `_${escapeItalic(text)}_`),
    accent: (text: string) => (format === "cli" ? pc.green(text) : `**${text}**`),
  };
}

export function formatWorkflowList(entries: WorkflowListEntry[], options: { format: WorkflowTextFormat }): string {
  const { format } = options;
  if (entries.length === 0) {
    return format === "cli"
      ? "没有找到任何工作流。使用 /ads.new 创建一个新的工作流。"
      : "没有找到任何工作流。使用 `/ads.new` 创建一个新的工作流。";
  }

  if (format === "cli") {
    const lines: string[] = [];
    lines.push("现有工作流：");
    entries.forEach((wf, index) => {
      lines.push(
        `${index + 1}. [${wf.template}] ${wf.title} (节点: ${wf.node_count}, 已定稿: ${wf.finalized_count}) - ${wf.workflow_id}`,
      );
    });
    return lines.join("\n");
  }

  const helpers = createFormatHelpers("markdown");
  const lines: string[] = [];
  lines.push("**现有工作流**");

  entries.forEach((wf, index) => {
    const title = helpers.escape(wf.title ?? "(未命名)");
    const template = wf.template
      ? helpers.code(wf.template)
      : helpers.muted("unknown");
    const stats = `节点: ${wf.node_count}, 已定稿: ${wf.finalized_count}`;
    const workflowId = helpers.code(wf.workflow_id);

    lines.push(`${index + 1}. ${title}`);
    lines.push(`    - 模板: ${template}`);
    lines.push(`    - ${helpers.muted(stats)}`);
    lines.push(`    - ID: ${workflowId}`);
    lines.push("");
  });

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

export function formatWorkflowStatusSummary(
  data: WorkflowStatusSummaryData,
  options: { format: WorkflowTextFormat },
): string {
  const { workflow, steps, stepOrder, allWorkflows, nextActions } = data;
  const helpers = createFormatHelpers(options.format);
  const lines: string[] = [];

  const orderedSteps = stepOrder.length > 0 ? stepOrder : steps.map((step) => step.name);
  const stepLookup = new Map(steps.map((step) => [step.name, step]));

  lines.push(helpers.section("当前工作流"));
  const workflowId = workflow.workflow_id ?? "(unknown-id)";
  lines.push(helpers.info(`${helpers.code(workflowId)} • ${helpers.escape(workflow.title ?? "Unknown")}`));
  lines.push(helpers.info(`模板: ${helpers.code(workflow.template ?? "unknown")}`));
  if (workflow.current_step) {
    lines.push(helpers.info(`当前步骤: ${helpers.code(workflow.current_step)}`));
  }

  lines.push("");
  lines.push(helpers.section("步骤"));

  if (orderedSteps.length === 0) {
    lines.push(helpers.info("暂无可用步骤"));
  } else {
    for (const stepName of orderedSteps) {
      const info = stepLookup.get(stepName);
      if (!info) {
        lines.push(helpers.info(`○ ${helpers.escape(stepName)} ${helpers.muted("(未创建)")}`));
        continue;
      }
      const statusIcon = info.status === "finalized" ? "✅" : "📝";
      const currentMark = info.is_current ? ` ${helpers.muted("(当前)")}` : "";
      const label = info.label ?? stepName;
      const line = `${statusIcon} ${helpers.escape(stepName)}: ${helpers.escape(label)}${currentMark}`;
      lines.push(helpers.info(line));
    }
  }

  const totalSteps = orderedSteps.length || steps.length;
  const finalizedCount = orderedSteps.reduce((count, name) => {
    const info = stepLookup.get(name);
    if (info?.status === "finalized") {
      return count + 1;
    }
    return count;
  }, 0);
  const progress = totalSteps > 0 ? Math.round((finalizedCount / totalSteps) * 100) : 0;

  lines.push("");
  lines.push(helpers.section("进度"));
  lines.push(helpers.info(`${progress}% (${finalizedCount}/${totalSteps || 0})`));
  if (progress === 100) {
    lines.push(helpers.info("🎉 工作流已完成！"));
  }

  lines.push("");
  lines.push(helpers.section("代码审查"));
  if (workflow.review) {
    const statusLabel = helpers.code(workflow.review.status);
    const updated = workflow.review.updated_at ? ` · ${helpers.escape(workflow.review.updated_at)}` : "";
    lines.push(helpers.info(`状态: ${statusLabel}${updated}`));
    if (workflow.review.summary) {
      lines.push(helpers.info(`摘要: ${helpers.escape(workflow.review.summary)}`));
    }
    if (workflow.review.skip_reason) {
      lines.push(helpers.info(`跳过原因: ${helpers.escape(workflow.review.skip_reason)}`));
    }
  } else {
    lines.push(helpers.info("尚未执行代码审查。使用 /ads.review 触发检查。"));
  }

  if (allWorkflows.length > 0) {
    lines.push("");
    lines.push(helpers.section("所有工作流"));
    for (const wf of allWorkflows) {
      const isCurrent = wf.workflow_id === workflow.workflow_id;
      const prefix = isCurrent ? "★" : "•";
      const workflowSegment = `${prefix} ${helpers.code(wf.workflow_id)}`;
      const titleSegment = helpers.escape(wf.title ?? "(未命名)");
      const templateSegment = `模板:${helpers.code(wf.template ?? "unknown")}`;
      const statsSegment = `节点:${wf.node_count} 已定稿:${wf.finalized_count}`;
      const label = `${workflowSegment} ${titleSegment} ${templateSegment} ${statsSegment}`;
      lines.push(helpers.info(isCurrent ? helpers.accent(label) : label));
    }
  }

  if (nextActions.length > 0) {
    lines.push("");
    lines.push(helpers.section("💡 下一步"));
    for (const action of nextActions) {
      lines.push(helpers.info(`${helpers.escape(action.label)}: ${helpers.code(action.command)}`));
    }
  }

  return lines.join("\n");
}

export function formatWorkflowLog(entries: WorkflowLogEntry[], options: WorkflowLogFormatOptions): string {
  const helpers = createFormatHelpers(options.format);
  const lines: string[] = [];

  if (options.format === "cli") {
    lines.push(options.header);
  } else {
    lines.push(`**${helpers.escape(options.header)}**`);
  }

  for (const entry of entries) {
    const prefix = entry.isActive ? "★" : "•";
    const titleHint = options.showWorkflowTitle && entry.workflowTitle ? ` ${helpers.escape(entry.workflowTitle)}` : "";
    const stepLabel =
      entry.stepLabel && entry.stepLabel !== entry.stepName ? ` (${helpers.escape(entry.stepLabel)})` : "";
    const row = `${prefix} ${helpers.code(entry.workflowId)}${titleHint} v${entry.version} ${helpers.escape(entry.stepName)}${stepLabel} • ${helpers.escape(entry.timestamp)}`;
    lines.push(helpers.info(entry.isActive ? helpers.accent(row) : row));

    if (entry.changeDescription) {
      lines.push(helpers.subInfo(`描述: ${helpers.escape(entry.changeDescription)}`));
    }
    if (entry.filePath) {
      lines.push(helpers.subInfo(`文件: ${helpers.code(entry.filePath)}`));
    }
  }

  return lines.join("\n");
}

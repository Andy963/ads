import type { Context } from 'grammy';
import {
  getWorkflowStatusSummary,
  checkoutWorkflow,
  commitStep,
  listWorkflows,
  listWorkflowLog,
} from '../../workflow/service.js';
import { createWorkflowFromTemplate } from '../../workflow/templateService.js';
import { listRules, readRules } from '../../workspace/rulesService.js';
import { getCurrentWorkspace, initWorkspace } from '../../workspace/service.js';
import { syncAllNodesToFiles } from '../../graph/service.js';
import { buildAdsHelpMessage } from '../../workflow/commands.js';
import { escapeTelegramMarkdown } from '../../utils/markdown.js';
import { runReview, skipReview, showReviewReport } from '../../review/service.js';
import { WorkflowContext } from '../../workspace/context.js';

const REVIEW_LOCK_SAFE_COMMANDS = new Set([
  'ads.init',
  'ads.review',
  'ads.status',
  'ads.log',
  'ads.help',
  'ads.rules',
  'ads.workspace',
  'ads.branch',
  'ads.checkout',
]);

export async function handleAdsCommand(ctx: Context, args: string[], options?: { workspacePath?: string }) {
  if (args.length === 0) {
    await ctx.reply(
      '用法示例：\n' +
        '/ads.init [name] - 初始化工作区\n' +
        '/ads.status - 查看工作流状态\n' +
        '/ads.new <title> - 创建工作流\n' +
        '/ads.commit <step> - 定稿步骤',
      {
        parse_mode: 'Markdown',
      }
    );
    return;
  }

  const command = args[0].toLowerCase();
  const commandArgs = args.slice(1);
  const workspacePath = options?.workspacePath;
  const reviewLocked = WorkflowContext.isReviewLocked(workspacePath);
  const qualifiedCommand = `ads.${command}`;

  try {
    if (reviewLocked && !REVIEW_LOCK_SAFE_COMMANDS.has(qualifiedCommand)) {
      await ctx.reply('⚠️ 当前工作流正在执行 Review，请等待完成或使用 /ads.review --show 查看进度。', { parse_mode: 'Markdown' });
      return;
    }

    switch (command) {
      case 'init': {
        const name = commandArgs.join(' ') || undefined;
        const response = await initWorkspace({ name });
        await replyWithAdsText(ctx, response);
        break;
      }

      case 'status': {
        const response = await getWorkflowStatusSummary({ format: 'markdown', workspace_path: workspacePath });
        await replyWithAdsText(ctx, response, { markdown: true });
        break;
      }

      case 'new': {
        if (commandArgs.length === 0) {
          await ctx.reply('用法: /ads.new <title>', { parse_mode: 'Markdown' });
          return;
        }
        const title = commandArgs.join(' ');
        const response = await createWorkflowFromTemplate({
          title,
          template_id: 'unified',
          workspace_path: workspacePath,
          format: 'markdown',
        });
        await replyWithAdsText(ctx, response, { markdown: true });
        break;
      }

      case 'checkout': {
        if (commandArgs.length === 0) {
          await ctx.reply('用法: /ads.checkout <workflow>', { parse_mode: 'Markdown' });
          return;
        }
        const identifier = commandArgs.join(' ');
        const response = await checkoutWorkflow({
          workflow_identifier: identifier,
          workspace_path: workspacePath,
          format: 'markdown',
        });
        await replyWithAdsText(ctx, response, { markdown: true });
        break;
      }

      case 'commit': {
        if (commandArgs.length === 0) {
          await ctx.reply('用法: /ads.commit <step>', { parse_mode: 'Markdown' });
          return;
        }
        const stepName = commandArgs.join(' ');
        const response = await commitStep({ step_name: stepName, workspace_path: workspacePath, format: 'markdown' });
        await replyWithAdsText(ctx, response, { markdown: true });
        break;
      }

      case 'branch':
      case 'list': {
        const branchOptions = parseBranchArguments(commandArgs);
        const format = branchOptions.operation === "list" ? "markdown" : "cli";
        const response = await listWorkflows({ ...branchOptions, format, workspace_path: workspacePath });
        await replyWithAdsText(ctx, response, { markdown: branchOptions.operation === "list" });
        break;
      }

      case 'log': {
        const { limit, workflow } = parseLogArguments(commandArgs);
        const response = await listWorkflowLog({ limit, workflow, format: 'markdown', workspace_path: workspacePath });
        await replyWithAdsText(ctx, response, { markdown: true });
        break;
      }

      case 'rules': {
        if (commandArgs.length > 0) {
          const category = commandArgs.join(' ');
          const response = await listRules({ category, workspace_path: workspacePath });
          await replyWithAdsText(ctx, response);
        } else {
          const response = await readRules(workspacePath);
          await replyWithAdsText(ctx, response);
        }
        break;
      }

      case 'workspace': {
        const response = await getCurrentWorkspace();
        await replyWithAdsText(ctx, response);
        break;
      }

      case 'sync': {
        const response = await syncAllNodesToFiles({ workspace_path: workspacePath });
        await replyWithAdsText(ctx, response);
        break;
      }

      case 'review': {
        let agentParam: "codex" | "claude" | undefined;
        for (let i = 0; i < commandArgs.length; i += 1) {
          const token = commandArgs[i];
          if (token.startsWith("agent=")) {
            agentParam = token.slice("agent=".length).toLowerCase() as "codex" | "claude";
            commandArgs.splice(i, 1);
            break;
          }
          if (token === "--agent" && commandArgs[i + 1]) {
            agentParam = commandArgs[i + 1].toLowerCase() as "codex" | "claude";
            commandArgs.splice(i, 2);
            break;
          }
        }

        const subCommand = commandArgs[0]?.toLowerCase();
        if (subCommand === 'show') {
          const workflowId = commandArgs.slice(1).join(' ') || undefined;
          const response = await showReviewReport({ workspace_path: workspacePath, workflowId });
          await replyWithAdsText(ctx, response);
          break;
        }

        if (subCommand === 'skip') {
          const reason = commandArgs.slice(1).join(' ');
          if (!reason) {
            await ctx.reply('请提供跳过 Review 的原因，例如 `/ads.review skip 用户要求立即上线`。', { parse_mode: 'Markdown' });
            break;
          }
          const response = await skipReview({ workspace_path: workspacePath, reason, requestedBy: 'telegram' });
          await replyWithAdsText(ctx, response);
          break;
        }

        // 先发送提示，让用户知道 Review 正在执行
        await ctx.reply('🔍 正在执行 Review，请稍候...', { disable_notification: true });
        const response = await runReview({ workspace_path: workspacePath, requestedBy: 'telegram', agent: agentParam });
        await replyWithAdsText(ctx, response);
        break;
      }

      case 'help': {
        const message = buildAdsHelpMessage('markdown');
        await replyWithAdsText(ctx, message, { markdown: true });
        break;
      }

      default:
        await ctx.reply(`未知命令: ${command}\n使用 /ads.help 查看可用命令`, {
          parse_mode: 'Markdown',
        });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ 命令执行失败: ${errorMsg}`);
    console.error('[ADS] Command error:', error);
  }
}

function formatAdsResponse(response: unknown): string {
  // 如果是 JSON 字符串，先解析
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      return formatAdsResponse(parsed);
    } catch {
      // 不是 JSON，直接返回
      return response;
    }
  }

  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;

    // 处理成功的工作流创建
    if (obj.success && obj.workflow && obj.message) {
      const workflow = obj.workflow as Record<string, unknown>;
      const lines = [
        '✅ 工作流创建成功',
        '',
        `📋 Root Node: \`${workflow.root_node_id}\``,
        `📊 创建节点数: ${workflow.nodes_created}`,
        `🔗 创建边数: ${workflow.edges_created}`,
        '',
        `💡 ${obj.message}`,
      ];
      return lines.join('\n');
    }

    // 处理通用成功消息
    if (obj.success && obj.message) {
      return `✅ ${obj.message}`;
    }

    // 处理错误
    if (obj.error) {
      return `❌ ${obj.error}`;
    }

    // 尝试提取常见字段
    if (obj.message && typeof obj.message === 'string') {
      return obj.message;
    }

    if (obj.output && typeof obj.output === 'string') {
      return obj.output;
    }
  }

  return JSON.stringify(response, null, 2);
}

async function replyWithAdsText(ctx: Context, response: unknown, options?: { markdown?: boolean }) {
  const text = formatAdsResponse(response);
  if (options?.markdown) {
    await ctx.reply(text, { parse_mode: 'Markdown' }).catch(async () => {
      await ctx.reply(text);
    });
    return;
  }

  const safeText = escapeTelegramMarkdown(text);
  await ctx.reply(safeText, { parse_mode: 'Markdown' }).catch(async () => {
    await ctx.reply(text);
  });
}

function parseBranchArguments(args: string[]): { operation: "list" | "delete" | "force_delete"; workflow?: string } {
  let deleteMode: "none" | "soft" | "hard" = "none";
  let workflowArg: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-d" || token === "--delete-context") {
      deleteMode = "soft";
      workflowArg = args.slice(i + 1).join(" ") || workflowArg;
      break;
    }
    if (token === "-D" || token === "--delete" || token === "--force-delete") {
      deleteMode = "hard";
      workflowArg = args.slice(i + 1).join(" ") || workflowArg;
      break;
    }
    if (token.startsWith("--delete=")) {
      deleteMode = "hard";
      workflowArg = token.slice("--delete=".length) || workflowArg;
      if (!workflowArg && i + 1 < args.length) {
        workflowArg = args[i + 1];
      }
      break;
    }
    if (token.startsWith("--delete-context=")) {
      deleteMode = "soft";
      workflowArg = token.slice("--delete-context=".length) || workflowArg;
      if (!workflowArg && i + 1 < args.length) {
        workflowArg = args[i + 1];
      }
      break;
    }
  }

  const operation = deleteMode === "hard" ? "force_delete" : deleteMode === "soft" ? "delete" : "list";
  const workflow = deleteMode === "none" ? undefined : workflowArg?.trim().replace(/^['"]|['"]$/g, "");
  return { operation, workflow };
}

function parseLogArguments(args: string[]): { limit?: number; workflow?: string } {
  if (args.length === 0) {
    return {};
  }
  const maybeLimit = Number(args[0]);
  if (!Number.isNaN(maybeLimit)) {
    const workflow = args.slice(1).join(" ") || undefined;
    return { limit: maybeLimit, workflow };
  }
  return { workflow: args.join(" ") };
}

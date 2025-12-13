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
import { escapeTelegramMarkdownV2 } from '../../utils/markdown.js';
import { runReview, skipReview, showReviewReport } from '../../review/service.js';
import { REVIEW_LOCK_SAFE_COMMANDS } from '../../utils/reviewLock.js';
import { createLogger } from '../../utils/logger.js';
import { WorkflowContext } from '../../workspace/context.js';

const logger = createLogger('TelegramADS');

export async function handleAdsCommand(ctx: Context, args: string[], options?: { workspacePath?: string }) {
  const replyMarkdownV2 = async (text: string, extra?: Parameters<Context['reply']>[1]) => {
    const escaped = escapeTelegramMarkdownV2(text);
    try {
      await ctx.reply(escaped, { parse_mode: 'MarkdownV2', ...extra });
    } catch (error) {
      logger.debug('[TelegramADS] Failed to send MarkdownV2 reply, falling back to plain text', error);
      await ctx.reply(text, extra);
    }
  };

  if (args.length === 0) {
    await replyMarkdownV2(
      '用法示例：\n' +
        '/ads.init [name] - 初始化工作区\n' +
        '/ads.status - 查看工作流状态\n' +
        '/ads.new <title> - 创建工作流\n' +
        '/ads.commit <step> - 定稿步骤'
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
      await replyMarkdownV2('⚠️ 当前工作流正在执行 Review，请等待完成或使用 /ads.review --show 查看进度。');
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
          await replyMarkdownV2('用法: /ads.new <title>');
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
          await replyMarkdownV2('用法: /ads.checkout <workflow>');
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
          await replyMarkdownV2('用法: /ads.commit <step>');
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
        let includeSpec = false;
        let specMode: "default" | "forceInclude" | "forceExclude" = "default";
        let commitRef: string | undefined;
        for (let i = 0; i < commandArgs.length; i += 1) {
          const token = commandArgs[i];
          const normalized = token.toLowerCase();
          if (token.startsWith("agent=")) {
            agentParam = token.slice("agent=".length).toLowerCase() as "codex" | "claude";
            commandArgs.splice(i, 1);
            i -= 1;
            continue;
          }
          if (token === "--agent" && commandArgs[i + 1]) {
            agentParam = commandArgs[i + 1].toLowerCase() as "codex" | "claude";
            commandArgs.splice(i, 2);
            i -= 1;
            continue;
          }
          if (isNoSpecToken(normalized)) {
            includeSpec = false;
            specMode = "forceExclude";
            commandArgs.splice(i, 1);
            i -= 1;
            continue;
          }
          if (normalized.startsWith("spec=")) {
            const parsed = parseBooleanFlag(token.slice(token.indexOf("=") + 1));
            if (parsed !== undefined) {
              includeSpec = parsed;
              specMode = includeSpec ? "forceInclude" : "forceExclude";
            }
            commandArgs.splice(i, 1);
            i -= 1;
            continue;
          }
          if (normalized === "--spec") {
            includeSpec = true;
            specMode = "forceInclude";
            commandArgs.splice(i, 1);
            i -= 1;
            continue;
          }
          if (normalized === "commit" || normalized === "--commit") {
            const next = commandArgs[i + 1];
            if (next && !next.startsWith("--")) {
              commitRef = next.trim();
              commandArgs.splice(i, 2);
            } else {
              commitRef = "HEAD";
              commandArgs.splice(i, 1);
            }
            i -= 1;
            continue;
          }
          if (normalized.startsWith("commit=") || normalized.startsWith("--commit=")) {
            const ref = token.slice(token.indexOf("=") + 1).trim();
            commitRef = ref || "HEAD";
            commandArgs.splice(i, 1);
            i -= 1;
            continue;
          }
        }

        const subCommand = commandArgs[0]?.toLowerCase();
        if (subCommand === 'show' || subCommand === '--show') {
          const workflowId = commandArgs.slice(1).join(' ') || undefined;
          const response = await showReviewReport({ workspace_path: workspacePath, workflowId });
          await replyWithAdsText(ctx, response, { markdown: true });
          break;
        }

        if (subCommand === 'skip' || subCommand === '--skip') {
          const reason = commandArgs.slice(1).join(' ');
          if (!reason) {
            await replyMarkdownV2('请提供跳过 Review 的原因，例如 `/ads.review skip 用户要求立即上线`。');
            break;
          }
          const response = await skipReview({ workspace_path: workspacePath, reason, requestedBy: 'telegram' });
          await replyWithAdsText(ctx, response);
          break;
        }

        // 先发送提示，让用户知道 Review 正在执行
        const modeLabel = describeReviewMode(includeSpec, commitRef);
        const statusMessage = await ctx.reply(escapeTelegramMarkdownV2(`🔍 正在执行 Review | 模式: ${modeLabel}`), {
          disable_notification: true,
          parse_mode: 'MarkdownV2',
        });
        const stopSpinner = startReviewSpinner(ctx, statusMessage, modeLabel);
        try {
          const response = await runReview({
            workspace_path: workspacePath,
            requestedBy: 'telegram',
            agent: agentParam,
            includeSpec,
            commitRef,
            specMode,
          });
          await stopSpinner(`✅ Review 完成，结果如下（模式: ${modeLabel}）`);
          await replyWithAdsText(ctx, response, { markdown: true });
        } catch (error) {
          await stopSpinner(`❌ Review 执行失败（模式: ${modeLabel}），请稍后重试。`);
          throw error;
        }
        break;
      }

      case 'help': {
        const message = buildAdsHelpMessage('markdown');
        await replyWithAdsText(ctx, message, { markdown: true });
        break;
      }

      default:
        await replyMarkdownV2(`未知命令: ${command}\n使用 /ads.help 查看可用命令`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await replyMarkdownV2(`❌ 命令执行失败: ${errorMsg}`);
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

async function replyWithAdsText(ctx: Context, response: unknown, _options?: { markdown?: boolean }) {
  const text = formatAdsResponse(response);
  const escaped = escapeTelegramMarkdownV2(text);
  await ctx.reply(escaped, { parse_mode: 'MarkdownV2' }).catch(async (error) => {
    logger.debug('[TelegramADS] Failed to send MarkdownV2 response, falling back to plain text', error);
    await ctx.reply(text);
  });
}

function startReviewSpinner(
  ctx: Context,
  statusMessage: { message_id: number; chat?: { id: number } } | undefined,
  modeLabel: string,
) {
  if (!statusMessage || !ctx.chat) {
    return async (finalText?: string) => {
      void finalText;
    };
  }
  const chatId = statusMessage.chat?.id ?? ctx.chat.id;
  const messageId = statusMessage.message_id;
  const frames = [' 🟢', ' 🟡', ' 🔴', ' 🟡'];
  let frameIndex = 0;
  const updateText = () => `🔍 正在执行 Review | 模式: ${modeLabel}${frames[frameIndex]}`;
  let timer: NodeJS.Timeout | undefined;
  let editFailed = false;

  const safeEdit = (text: string, stage: string) => {
    if (editFailed) {
      return;
    }
    ctx.api.editMessageText(chatId, messageId, text, { parse_mode: 'MarkdownV2' }).catch((error) => {
      editFailed = true;
      logger.warn(`[TelegramADS] Failed to update review spinner (${stage})`, error);
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });
  };

  const tick = () => {
    frameIndex = (frameIndex + 1) % frames.length;
    const escaped = escapeTelegramMarkdownV2(updateText());
    safeEdit(escaped, 'tick');
  };
  const firstText = escapeTelegramMarkdownV2(updateText());
  safeEdit(firstText, 'init');
  timer = setInterval(tick, 1000);

  return async (finalText?: string) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (finalText) {
      const escaped = escapeTelegramMarkdownV2(finalText);
      await ctx.api.editMessageText(chatId, messageId, escaped, { parse_mode: 'MarkdownV2' }).catch((error) => {
        logger.warn('[TelegramADS] Failed to finalize review status message', error);
      });
    }
  };
}

function describeReviewMode(includeSpec: boolean, commitRef?: string): string {
  const target = commitRef ? `提交 ${formatCommitRef(commitRef)}` : "未提交代码";
  const specLabel = includeSpec ? "附带 spec" : "仅代码 diff";
  return `${target} · ${specLabel}`;
}

function formatCommitRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.toUpperCase() === "HEAD") {
    return "HEAD";
  }
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function parseBooleanFlag(value?: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function isNoSpecToken(token: string): boolean {
  const normalized = token.toLowerCase();
  return normalized === "--no-spec" || normalized === "no-spec" || normalized === "--nospec" || normalized === "nospec";
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

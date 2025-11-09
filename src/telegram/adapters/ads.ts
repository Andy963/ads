import type { Context } from 'grammy';
import { getWorkflowStatusSummary, checkoutWorkflow, commitStep } from '../../workflow/service.js';
import { createWorkflowFromTemplate } from '../../workflow/templateService.js';

export async function handleAdsCommand(ctx: Context, args: string[]) {
  if (args.length === 0) {
    await ctx.reply('用法: /ads <command> [args]\n使用 /ads help 查看可用命令', {
      parse_mode: 'Markdown'
    });
    return;
  }

  const command = args[0].toLowerCase();
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case 'status': {
        const response = await getWorkflowStatusSummary({});
        const text = formatAdsResponse(response);
        const safeText = escapeMarkdown(text);
        await ctx.reply(safeText, { parse_mode: 'Markdown' }).catch(async () => {
          await ctx.reply(text); // Fallback to plain text
        });
        break;
      }

      case 'new': {
        if (commandArgs.length === 0) {
          await ctx.reply('用法: /ads new <title>', { parse_mode: 'Markdown' });
          return;
        }
        const title = commandArgs.join(' ');
        const response = await createWorkflowFromTemplate({
          title,
          template_id: 'unified',
        });
        const text = formatAdsResponse(response);
        const safeText = escapeMarkdown(text);
        await ctx.reply(safeText, { parse_mode: 'Markdown' }).catch(async () => {
          await ctx.reply(text);
        });
        break;
      }

      case 'checkout': {
        if (commandArgs.length === 0) {
          await ctx.reply('用法: /ads checkout <workflow>', { parse_mode: 'Markdown' });
          return;
        }
        const identifier = commandArgs.join(' ');
        const response = await checkoutWorkflow({ workflow_identifier: identifier });
        const text = formatAdsResponse(response);
        const safeText = escapeMarkdown(text);
        await ctx.reply(safeText, { parse_mode: 'Markdown' }).catch(async () => {
          await ctx.reply(text);
        });
        break;
      }

      case 'commit': {
        if (commandArgs.length === 0) {
          await ctx.reply('用法: /ads commit <step>', { parse_mode: 'Markdown' });
          return;
        }
        const stepName = commandArgs.join(' ');
        const response = await commitStep({ step_name: stepName });
        const text = formatAdsResponse(response);
        const safeText = escapeMarkdown(text);
        await ctx.reply(safeText, { parse_mode: 'Markdown' }).catch(async () => {
          await ctx.reply(text);
        });
        break;
      }

      case 'help': {
        await ctx.reply(
          '📋 *ADS 命令列表*\n\n' +
          '`/ads status` - 查看当前工作流状态\n' +
          '`/ads new <title>` - 创建新工作流\n' +
          '`/ads checkout <workflow>` - 切换工作流\n' +
          '`/ads commit <step>` - 定稿步骤\n' +
          '`/ads help` - 显示此帮助',
          { parse_mode: 'Markdown' }
        );
        break;
      }

      default:
        await ctx.reply(`未知命令: ${command}\n使用 /ads help 查看可用命令`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ 命令执行失败: ${errorMsg}`);
    console.error('[ADS] Command error:', error);
  }
}

function formatAdsResponse(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    
    // 尝试提取常见字段
    if (obj.message && typeof obj.message === 'string') {
      return obj.message;
    }

    if (obj.output && typeof obj.output === 'string') {
      return obj.output;
    }

    if (obj.success && obj.message) {
      return `✅ ${obj.message}`;
    }

    if (obj.error) {
      return `❌ ${obj.error}`;
    }
  }

  return JSON.stringify(response, null, 2);
}

const MARKDOWN_ESCAPE_REGEX = /([_\*\[\]\(\)~`#+=|{}!])/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE_REGEX, '\\$1');
}

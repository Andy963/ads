import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { interruptExecution } from '../adapters/codex.js';
import { getDailyNoteFilePath } from '../utils/noteLogger.js';
import { detectWorkspaceFrom } from '../../workspace/detector.js';
import { listPreferences, setPreference, deletePreference } from '../../memory/soul.js';
import { listAgentSessions } from '../../agents/sessions/catalog.js';
import {
  formatSessionListMessage,
  parseSessionCallbackData,
} from '../utils/sessionListMessage.js';
import { requireUserId, type TelegramBotRuntime } from './shared.js';

export const TELEGRAM_CONTROL_COMMANDS = new Set([
  'start',
  'help',
  'status',
  'agent',
  'esc',
  'reset',
  'resume',
  'sessions',
  'mark',
  'pwd',
  'cd',
  'pref',
]);

/** Telegram cannot scroll a keyboard, so the list stays short and searchable. */
const SESSION_LIST_PAGE_SIZE = 8;

export async function registerTelegramCommandMenu(
  bot: Bot<Context>,
  logger: TelegramBotRuntime['logger'],
): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: '欢迎信息' },
      { command: 'help', description: '命令帮助' },
      { command: 'status', description: '系统状态' },
      { command: 'agent', description: '查看或切换代理' },
      { command: 'esc', description: '中断当前任务' },
      { command: 'reset', description: '开始新对话' },
      { command: 'resume', description: '恢复之前的对话' },
      { command: 'sessions', description: '列出可恢复的历史会话' },
      { command: 'mark', description: '记录对话到笔记' },
      { command: 'pwd', description: '当前目录' },
      { command: 'cd', description: '切换目录' },
      { command: 'pref', description: '管理偏好设置' },
    ]);
    logger.info('Telegram commands registered');
  } catch (error) {
    logger.warn(`Failed to register Telegram commands (will continue): ${(error as Error).message}`);
  }
}

export function registerTelegramControlCommands(bot: Bot<Context>, runtime: TelegramBotRuntime): void {  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 欢迎使用 Codex Telegram Bot!\n\n' +
        '可用命令：\n' +
        '/help - 查看所有命令\n' +
        '/status - 查看系统状态\n' +
        '/agent - 查看或切换代理\n' +
        '/reset - 重置会话\n' +
        '/sessions - 列出可恢复的历史会话\n' +
        '/mark - 切换对话标记，记录到当天 note\n' +
        '/pref - 管理偏好设置（长期记忆）\n' +
        '/pwd - 查看当前目录\n' +
        '/cd <path> - 切换目录\n\n' +
        '直接发送文本与 Codex 对话',
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '📖 Codex Telegram Bot 命令列表\n\n' +
        '🔧 系统命令：\n' +
        '/start - 欢迎信息\n' +
        '/help - 显示此帮助\n' +
        '/status - 系统状态\n' +
        '/agent [id] - 查看可用代理或切换代理\n' +
        '/reset - 重置会话（开始新对话）\n' +
        '/resume - 恢复之前的对话\n' +
        '/sessions [关键词] - 列出可恢复的历史会话并选择续接\n' +
        '/mark - 切换对话标记（记录每日 note）\n' +
        '/pref [list|add|del] - 管理偏好设置（长期记忆）\n' +
        '/esc - 中断当前任务（Agent 保持运行）\n\n' +
        '📁 目录管理：\n' +
        '/pwd - 当前工作目录\n' +
        '/cd <path> - 切换目录\n\n' +
        '💬 对话：\n' +
        '直接发送消息与 Codex AI 对话\n' +
        '发送图片可让 Codex 分析图像\n' +
        '发送文件让 Codex 处理文件\n' +
        '执行过程中可用 /esc 中断当前任务',
    );
  });

  bot.command('status', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/status');
    if (userId === null) return;
    const stats = runtime.sessionManager.getStats();
    const cwd = runtime.directoryManager.getUserCwd(userId);
    const currentModel = runtime.sessionManager.getUserModel(userId);
    const currentAgent = runtime.sessionManager.getActiveAgentLabel(userId);

    const sandboxEmoji = {
      'read-only': '🔒',
      'workspace-write': '✏️',
      'danger-full-access': '⚠️',
    }[stats.sandboxMode];

    await ctx.reply(
      '📊 系统状态\n\n' +
        `💬 会话统计: ${stats.active} 活跃 / ${stats.total} 总数\n` +
        `${sandboxEmoji} 沙箱模式: ${stats.sandboxMode}\n` +
        `🤖 当前模型: ${currentModel}\n` +
        `🧠 当前代理: ${currentAgent}\n` +
        `📁 当前目录: ${cwd}`,
    );
  });

  bot.command('agent', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/agent');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const requestedAgentId = args.join(' ').trim();
    const cwd = runtime.directoryManager.getUserCwd(userId);

    if (requestedAgentId) {
      runtime.sessionManager.getOrCreate(userId, cwd, true);
      const result = runtime.sessionManager.switchAgent(userId, requestedAgentId);
      await ctx.reply(result.message);
      return;
    }

    const orchestrator = runtime.sessionManager.getOrCreate(userId, cwd, true);
    const activeAgentId = orchestrator.getActiveAgentId();
    const lines = orchestrator.listAgents().map((entry) => {
      const marker = entry.metadata.id === activeAgentId ? '*' : '-';
      const status = entry.status.ready ? 'ready' : `not ready${entry.status.error ? `: ${entry.status.error}` : ''}`;
      return `${marker} ${entry.metadata.id} (${entry.metadata.name}) - ${status}`;
    });
    await ctx.reply(
      `当前代理: ${activeAgentId}\n\n可用代理:\n${lines.join('\n')}\n\n用法: /agent <id>`,
    );
  });

  bot.command('reset', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/reset');
    if (userId === null) return;
    runtime.sessionManager.reset(userId);
    await ctx.reply('✅ 代理会话已重置，新对话已开始');
  });

  bot.command('resume', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/resume');
    if (userId === null) return;
    await ctx.reply('ℹ️ 用 /sessions 列出可恢复的历史会话，点击其中一条即可续接；/reset 开始新对话');
  });

  bot.command('sessions', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/sessions');
    if (userId === null) return;
    const cwd = runtime.directoryManager.getUserCwd(userId);
    const { activeAgentId } = runtime.sessionManager.getEffectiveState(userId);
    const searchTerm = (ctx.message?.text ?? '').split(/\s+/).slice(1).join(' ').trim() || undefined;

    try {
      const result = await listAgentSessions(
        { currentSessionId: runtime.sessionManager.getSavedThreadId(userId, activeAgentId) },
        { agentId: activeAgentId, cwd, limit: SESSION_LIST_PAGE_SIZE, searchTerm },
      );
      const message = formatSessionListMessage({
        items: result.items,
        agentId: activeAgentId,
        cwd,
        degraded: result.degraded,
        hidden: result.hidden,
      });
      const keyboard = new InlineKeyboard();
      for (const button of message.buttons) {
        keyboard.text(button.label, button.data).row();
      }
      await ctx.reply(message.text, message.buttons.length > 0 ? { reply_markup: keyboard } : undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      runtime.logger.warn(`[Telegram] /sessions failed agent=${activeAgentId} err=${detail}`);
      await ctx.reply(`❌ 无法列出历史会话：${detail}`);
    }
  });

  bot.callbackQuery(/^sr:/, async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, 'callbackQuery:sr');
    if (userId === null) return;
    const sessionId = parseSessionCallbackData(ctx.callbackQuery.data);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '会话标识无效', show_alert: true });
      return;
    }

    const { activeAgentId } = runtime.sessionManager.getEffectiveState(userId);
    // Saving first and then dropping the live session is what makes the next
    // message reattach: `getOrCreate(..., resumeThread)` reads the saved id.
    runtime.sessionManager.saveThreadId(userId, sessionId, activeAgentId);
    runtime.sessionManager.dropSession(userId);
    runtime.logger.info(`[Telegram] /sessions resume user=${userId} agent=${activeAgentId} session=${sessionId}`);

    await ctx.answerCallbackQuery({ text: '已选择该会话' });
    await ctx.reply(`✅ 已切换到会话 ${sessionId.slice(0, 8)}，下一条消息将接续它的上下文`);
  });

  bot.command('mark', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/mark');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const current = runtime.markStates.get(userId) ?? false;
    let nextState: boolean | null = null;

    if (args.length === 0) {
      nextState = !current;
    } else {
      const normalized = args[0]?.toLowerCase() ?? '';
      if (['on', 'enable', 'start', 'true', '1'].includes(normalized)) {
        nextState = true;
      } else if (['off', 'disable', 'stop', 'false', '0'].includes(normalized)) {
        nextState = false;
      } else if (['status', '?'].includes(normalized)) {
        await ctx.reply(current ? '📝 标记模式：开启' : '📝 标记模式：关闭');
        return;
      } else {
        await ctx.reply('用法: /mark [on|off]\n省略参数将切换当前状态');
        return;
      }
    }

    runtime.markStates.set(userId, nextState);
    if (nextState) {
      const cwd = runtime.directoryManager.getUserCwd(userId);
      const notePath = getDailyNoteFilePath(cwd);
      await ctx.reply(`📝 标记模式已开启\n将在 ${notePath} 记录后续对话`);
      return;
    }

    await ctx.reply('📝 标记模式已关闭');
  });

  bot.command('esc', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/esc');
    if (userId === null) return;
    const interrupted = interruptExecution(userId);
    if (interrupted) {
      await ctx.reply('⛔️ 已中断当前任务\n✅ Agent 仍在运行，可以发送新指令');
      return;
    }
    await ctx.reply('ℹ️ 当前没有正在执行的任务');
  });

  bot.command('pwd', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/pwd');
    if (userId === null) return;
    const cwd = runtime.directoryManager.getUserCwd(userId);
    await ctx.reply(`📁 当前工作目录: ${cwd}`);
  });

  bot.command('pref', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/pref');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const sub = args[0]?.toLowerCase();
    const cwd = runtime.directoryManager.getUserCwd(userId);
    const workspaceRoot = detectWorkspaceFrom(cwd);

    if (!sub || sub === 'list') {
      const prefs = listPreferences(workspaceRoot);
      if (prefs.length === 0) {
        await ctx.reply('📋 暂无偏好设置\n\n用法: /pref add <key> <value>');
        return;
      }
      const lines = prefs.map((p) => `• **${p.key}**: ${p.value}`);
      await ctx.reply(`📋 偏好设置 (${prefs.length})\n\n${lines.join('\n')}`);
      return;
    }

    if (sub === 'add' || sub === 'set') {
      const key = args[1];
      const value = args.slice(2).join(' ').trim();
      if (!key || !value) {
        await ctx.reply('用法: /pref add <key> <value>');
        return;
      }
      setPreference(workspaceRoot, key, value);
      await ctx.reply(`✅ 偏好已保存: **${key}** = ${value}`);
      return;
    }

    if (sub === 'del' || sub === 'delete' || sub === 'rm') {
      const key = args[1];
      if (!key) {
        await ctx.reply('用法: /pref del <key>');
        return;
      }
      const deleted = deletePreference(workspaceRoot, key);
      if (deleted) {
        await ctx.reply(`✅ 已删除偏好: ${key}`);
      } else {
        await ctx.reply(`❌ 未找到偏好: ${key}`);
      }
      return;
    }

    await ctx.reply(
      '📖 偏好设置命令\n\n' +
        '/pref list — 列出所有偏好\n' +
        '/pref add <key> <value> — 添加/更新偏好\n' +
        '/pref del <key> — 删除偏好',
    );
  });

  bot.command('cd', async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, '/cd');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1);

    if (!args || args.length === 0) {
      await ctx.reply('用法: /cd <path>');
      return;
    }

    const targetPath = args.join(' ');
    const prevCwd = runtime.directoryManager.getUserCwd(userId);
    const result = runtime.directoryManager.setUserCwd(userId, targetPath);

    if (!result.success) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }

    const newCwd = runtime.directoryManager.getUserCwd(userId);
    runtime.sessionManager.setUserCwd(userId, newCwd);
    let replyMessage = `✅ 已切换到: ${newCwd}`;
    if (prevCwd !== newCwd) {
      replyMessage += '\n💡 代理上下文已切换到新目录';
    } else {
      replyMessage += '\nℹ️ 已在相同目录，无需重置会话';
    }

    await ctx.reply(replyMessage);
  });
}

import type { Bot, Context } from 'grammy';
import { interruptExecution } from '../adapters/codex.js';
import { getDailyNoteFilePath } from '../utils/noteLogger.js';
import { detectWorkspaceFrom } from '../../workspace/detector.js';
import { listPreferences, setPreference, deletePreference } from '../../memory/soul.js';
import { requireUserId, type TelegramBotRuntime } from './shared.js';

export const TELEGRAM_CONTROL_COMMANDS = new Set([
  'start',
  'help',
  'status',
  'esc',
  'reset',
  'resume',
  'mark',
  'pwd',
  'cd',
  'pref',
]);

export async function registerTelegramCommandMenu(
  bot: Bot<Context>,
  logger: TelegramBotRuntime['logger'],
): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: '欢迎信息' },
      { command: 'help', description: '命令帮助' },
      { command: 'status', description: '系统状态' },
      { command: 'esc', description: '中断当前任务' },
      { command: 'reset', description: '开始新对话' },
      { command: 'resume', description: '恢复之前的对话' },
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

export function registerTelegramControlCommands(bot: Bot<Context>, runtime: TelegramBotRuntime): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 欢迎使用 Codex Telegram Bot!\n\n' +
        '可用命令：\n' +
        '/help - 查看所有命令\n' +
        '/status - 查看系统状态\n' +
        '/reset - 重置会话\n' +
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
        '/reset - 重置会话（开始新对话）\n' +
        '/resume - 恢复之前的对话\n' +
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
        `🧠 当前代理: Codex\n` +
        `📁 当前目录: ${cwd}`,
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
    await ctx.reply('❌ 精简版不支持恢复对话，请使用 /reset 开始新对话');
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

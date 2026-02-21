import '../utils/logSink.js';
import '../utils/env.js';

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { loadTelegramConfig, validateConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { resolveCodexConfig } from '../codexConfig.js';
import { SessionManager } from './utils/sessionManager.js';
import { DirectoryManager } from './utils/directoryManager.js';
import { handleCodexMessage, interruptExecution, hasActiveCodexRequest } from './adapters/codex.js';
import { cleanupAllTempFiles } from './utils/fileHandler.js';
import { createLogger } from '../utils/logger.js';
import { HttpsProxyAgent } from './utils/proxyAgent.js';
import { getDailyNoteFilePath } from './utils/noteLogger.js';
import { detectWorkspaceFrom } from '../workspace/detector.js';
import { closeAllStateDatabases } from '../state/database.js';
import { listPreferences, setPreference, deletePreference } from '../memory/soul.js';
import { closeAllWorkspaceDatabases } from '../storage/database.js';
import { installApiDebugLogging, installSilentReplyMiddleware, parseBooleanFlag } from './botSetup.js';
import { escapeTelegramMarkdownV2 } from '../utils/markdown.js';
import { transcribeTelegramVoiceMessage } from './utils/voiceTranscription.js';
import { PendingTranscriptionStore } from './utils/pendingTranscriptions.js';
import {
  cancelTelegramTaskDraft,
  confirmTelegramTaskDraft,
  createTelegramTaskDraft,
  deriveTelegramAuthUserId,
  getTelegramTaskDraft,
} from './utils/taskDrafts.js';

const logger = createLogger('Bot');
const markStates = new Map<number, boolean>();
const TELEGRAM_CONTROL_COMMANDS = new Set([
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
  'draft',
]);

let crashHandlingStarted = false;

function gracefulShutdownAndExit(reason: string, error: unknown): void {
  if (crashHandlingStarted) {
    return;
  }
  crashHandlingStarted = true;

  logger.error(`[Crash] ${reason}`, error);

  const timeoutMsRaw = Number(process.env.ADS_SHUTDOWN_TIMEOUT_MS ?? 1500);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(100, Math.floor(timeoutMsRaw)) : 1500;
  const timer = setTimeout(() => {
    process.exit(1);
  }, timeoutMs);
  timer.unref?.();

  try {
    closeAllWorkspaceDatabases();
  } catch (closeError) {
    logger.warn(`[Crash] closeAllWorkspaceDatabases failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
  }
  try {
    closeAllStateDatabases();
  } catch (closeError) {
    logger.warn(`[Crash] closeAllStateDatabases failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
  }

  clearTimeout(timer);
  process.exit(1);
}

process.once('unhandledRejection', (reason) => {
  gracefulShutdownAndExit('Unhandled promise rejection', reason);
});

process.once('uncaughtException', (error) => {
  gracefulShutdownAndExit('Uncaught exception', error);
});

async function requireUserId(ctx: Context, action: string): Promise<number | null> {
  const userId = ctx.from?.id;
  if (typeof userId === 'number') {
    return userId;
  }
  logger.warn(`[Telegram] Missing ctx.from for ${action}`);
  if (ctx.chat) {
    await ctx.reply('❌ 无法识别用户信息（可能是匿名/频道消息），请用普通用户身份发送消息后重试。');
  }
  return null;
}

async function requirePrivateChat(ctx: Context, action: string): Promise<boolean> {
  const chatType = ctx.chat?.type;
  if (chatType === 'private') {
    return true;
  }
  logger.warn(`[Telegram] Non-private chat blocked for ${action}: type=${String(chatType ?? '')}`);
  if (ctx.chat) {
    await ctx.reply('❌ 该功能仅支持私聊（private chat）。');
  }
  return false;
}

async function main() {
  logger.info('Starting Telegram Bot...');

  // 加载配置
  let config;
  try {
    config = loadTelegramConfig();
    validateConfig(config);
    logger.info('Telegram config loaded');
    logger.info(`Single allowed user configured`);
    logger.info(`Allowed dirs: ${config.allowedDirs.join(', ')}`);
  } catch (error) {
    logger.error('Failed to load config:', (error as Error).message);
    process.exit(1);
  }

  // 验证 Codex 配置
  try {
    resolveCodexConfig();
    logger.info('Codex config validated');
  } catch (error) {
    logger.error('Failed to validate Codex config:', (error as Error).message);
    process.exit(1);
  }

  // 清理旧的临时文件
  cleanupAllTempFiles();

  const silentNotifications = parseBooleanFlag(process.env.TELEGRAM_SILENT_NOTIFICATIONS, true);
  logger.info(`[Config] TELEGRAM_SILENT_NOTIFICATIONS env=${process.env.TELEGRAM_SILENT_NOTIFICATIONS}, parsed=${silentNotifications}`);

  // 创建管理器
  const sessionManager = new SessionManager(
    config.sessionTimeoutMs,
    5 * 60 * 1000,
    config.sandboxMode,
    config.defaultModel
  );
  const directoryManager = new DirectoryManager(config.allowedDirs);
  const pendingTranscriptions = new PendingTranscriptionStore({ ttlMs: 5 * 60 * 1000 });

  const formatTranscriptionPreview = (args: { text: string; state: "pending" | "submitted" | "discarded" }): string => {
    const safeText = args.text.replace(/```/g, '`​``');
    const stateLabel =
      args.state === "pending"
        ? "📝 转录预览（不会自动发送）"
        : args.state === "submitted"
          ? "✅ 转录预览（已提交）"
          : "🗑️ 转录预览（已丢弃）";

    const footer =
      args.state === "pending"
        ? "点击 `Submit` 发送给 Codex；点击 `Discard` 丢弃。\n如需编辑：复制后修改，再发送新消息。\n有效期：5 分钟。"
        : "如需编辑：复制后修改，再发送新消息。";

    return `${stateLabel}\n\n\`\`\`text\n${safeText || "\u200b"}\n\`\`\`\n\n${footer}`;
  };

  const formatTaskDraftPreview = (args: {
    prompt: string;
    workspaceRoot: string;
    state: "pending" | "approved" | "cancelled";
    createdTaskIds?: string[];
  }): string => {
    const safePrompt = args.prompt.replace(/```/g, '`​``');
    const safeWorkspace = args.workspaceRoot.replace(/```/g, '`​``');
    const stateLabel =
      args.state === "pending"
        ? "🧾 任务草稿（待确认，不会自动入队）"
        : args.state === "approved"
          ? "✅ 任务草稿（已入队）"
          : "🗑️ 任务草稿（已取消）";

    const createdLine = (() => {
      const ids = (args.createdTaskIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
      if (!ids.length) {
        return "";
      }
      const shown = ids.slice(0, 5).map((id) => id.slice(0, 8));
      const suffix = ids.length > shown.length ? ` …(+${ids.length - shown.length})` : "";
      return `Created: \`${shown.join(", ")}\`${suffix}`;
    })();

    const footer =
      args.state === "pending"
        ? "点击 `Confirm & Run` 仅入队；不会在 TG 里直接执行。\n点击 `Cancel` 将取消该草稿。"
        : args.state === "approved"
          ? "如需调整：请重新创建新的草稿。"
          : "如需重新执行：请重新创建新的草稿。";

    const lines: string[] = [];
    lines.push(stateLabel);
    lines.push("");
    lines.push(`Workspace: \`${safeWorkspace || "\u200b"}\``);
    if (createdLine) {
      lines.push(createdLine);
    }
    lines.push("");
    lines.push("```text");
    lines.push(safePrompt || "\u200b");
    lines.push("```");
    lines.push("");
    lines.push(footer);
    return lines.join("\n");
  };

  // 启动时设置默认工作目录（单用户）
  const userId = config.allowedUsers[0];
  const defaultDir = config.allowedDirs[0];
  directoryManager.setUserCwd(userId, defaultDir);
  sessionManager.setUserCwd(userId, defaultDir);
  logger.info(`[Workspace] Using default cwd: ${defaultDir}`);

  // 创建 Bot 实例
  const clientConfig = config.proxyUrl
    ? {
      baseFetchConfig: {
        agent: new HttpsProxyAgent(config.proxyUrl),
      },
    }
    : undefined;

  const bot = new Bot(config.botToken, clientConfig ? { client: clientConfig } : undefined);

  bot.catch((error) => {
    logger.error('Unhandled bot error', (error as { error?: unknown }).error ?? error);
  });

  installApiDebugLogging(bot, logger);
  installSilentReplyMiddleware(bot, silentNotifications);

  // 注册中间件
  bot.use(createAuthMiddleware(config.allowedUsers));
  bot.use(createRateLimitMiddleware(config.maxRequestsPerMinute));

  // 注册命令列表（显示在 Telegram 输入框）
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
      { command: 'draft', description: '创建任务草稿（需确认后入队）' },
    ]);
    logger.info('Telegram commands registered');
  } catch (error) {
    logger.warn(`Failed to register Telegram commands (will continue): ${(error as Error).message}`);
  }

  // 基础命令
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 欢迎使用 Codex Telegram Bot!\n\n' +
      '可用命令：\n' +
      '/help - 查看所有命令\n' +
      '/status - 查看系统状态\n' +
      '/reset - 重置会话\n' +
      '/mark - 切换对话标记，记录到当天 note\n' +
      '/pref - 管理偏好设置（长期记忆）\n' +
      '/draft <text> - 创建任务草稿（需确认后入队）\n' +
      '/pwd - 查看当前目录\n' +
      '/cd <path> - 切换目录\n\n' +
      '直接发送文本与 Codex 对话'
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
      '🧾 Draft：\n' +
      '/draft <text> - 创建任务草稿（需确认后入队）\n\n' +
      '💬 对话：\n' +
      '直接发送消息与 Codex AI 对话\n' +
      '发送图片可让 Codex 分析图像\n' +
      '发送文件让 Codex 处理文件\n' +
      '执行过程中可用 /esc 中断当前任务'
    );
  });

  bot.command('status', async (ctx) => {
    const userId = await requireUserId(ctx, '/status');
    if (userId === null) return;
    const stats = sessionManager.getStats();
    const cwd = directoryManager.getUserCwd(userId);
    const currentModel = sessionManager.getUserModel(userId);

    const sandboxEmoji = {
      'read-only': '🔒',
      'workspace-write': '✏️',
      'danger-full-access': '⚠️'
    }[stats.sandboxMode];

    await ctx.reply(
      '📊 系统状态\n\n' +
      `💬 会话统计: ${stats.active} 活跃 / ${stats.total} 总数\n` +
      `${sandboxEmoji} 沙箱模式: ${stats.sandboxMode}\n` +
      `🤖 当前模型: ${currentModel}\n` +
      `🧠 当前代理: Codex\n` +
      `📁 当前目录: ${cwd}`
    );
  });

  bot.command('reset', async (ctx) => {
    const userId = await requireUserId(ctx, '/reset');
    if (userId === null) return;
    sessionManager.reset(userId);
    await ctx.reply('✅ 代理会话已重置，新对话已开始');
  });

  bot.command('resume', async (ctx) => {
    const userId = await requireUserId(ctx, '/resume');
    if (userId === null) return;
    // Simplified version doesn't persist threads
    await ctx.reply('❌ 精简版不支持恢复对话，请使用 /reset 开始新对话');
  });

  bot.command('mark', async (ctx) => {
    const userId = await requireUserId(ctx, '/mark');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const current = markStates.get(userId) ?? false;
    let nextState: boolean | null = null;

    if (args.length === 0) {
      nextState = !current;
    } else {
      const normalized = args[0].toLowerCase();
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

    markStates.set(userId, nextState);
    if (nextState) {
      const cwd = directoryManager.getUserCwd(userId);
      const notePath = getDailyNoteFilePath(cwd);
      await ctx.reply(`📝 标记模式已开启\n将在 ${notePath} 记录后续对话`);
    } else {
      await ctx.reply('📝 标记模式已关闭');
    }
  });

  bot.command('esc', async (ctx) => {
    const userId = await requireUserId(ctx, '/esc');
    if (userId === null) return;
    const interrupted = interruptExecution(userId);
    if (interrupted) {
      await ctx.reply('⛔️ 已中断当前任务\n✅ Agent 仍在运行，可以发送新指令');
    } else {
      await ctx.reply('ℹ️ 当前没有正在执行的任务');
    }
  });

  bot.command('pwd', async (ctx) => {
    const userId = await requireUserId(ctx, '/pwd');
    if (userId === null) return;
    const cwd = directoryManager.getUserCwd(userId);
    await ctx.reply(`📁 当前工作目录: ${cwd}`);
  });

	  bot.command('pref', async (ctx) => {
	    const userId = await requireUserId(ctx, '/pref');
	    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const sub = args[0]?.toLowerCase();
    const cwd = directoryManager.getUserCwd(userId);
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
      '/pref del <key> — 删除偏好'
    );
  });

  bot.command('cd', async (ctx) => {
    const userId = await requireUserId(ctx, '/cd');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1);

    if (!args || args.length === 0) {
      await ctx.reply('用法: /cd <path>');
      return;
    }

    const targetPath = args.join(' ');
    const prevCwd = directoryManager.getUserCwd(userId);
    const result = directoryManager.setUserCwd(userId, targetPath);

    if (result.success) {
      const newCwd = directoryManager.getUserCwd(userId);
      sessionManager.setUserCwd(userId, newCwd);
      let replyMessage = `✅ 已切换到: ${newCwd}`;
      if (prevCwd !== newCwd) {
        replyMessage += `\n💡 代理上下文已切换到新目录`;
      } else {
        replyMessage += `\nℹ️ 已在相同目录，无需重置会话`;
      }

      await ctx.reply(replyMessage);
    } else {
      await ctx.reply(`❌ ${result.error}`);
    }
  });

	  bot.command('draft', async (ctx) => {
	    const userId = await requireUserId(ctx, '/draft');
	    if (userId === null) return;
	    if (!(await requirePrivateChat(ctx, '/draft'))) return;

    const replyToMessageId = ctx.message?.message_id;
    const replyParameters = typeof replyToMessageId === 'number' ? { reply_parameters: { message_id: replyToMessageId } } : {};

	    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
	    const text = args.join(' ').trim();
	    if (!text) {
	      await ctx.reply('用法: /draft <text>');
	      return;
    }

    const cwd = directoryManager.getUserCwd(userId);
    const workspaceRoot = detectWorkspaceFrom(cwd);
    const authUserId = deriveTelegramAuthUserId(userId);
    const sourceChatSessionId = `tg:${String(ctx.chat?.id ?? '')}`;

    let draft;
    try {
      draft = createTelegramTaskDraft({ authUserId, workspaceRoot, sourceChatSessionId, text });
	    } catch (error) {
	      const message = error instanceof Error ? error.message : String(error);
	      await ctx.reply(`❌ 创建草稿失败: ${message}`, {
	        disable_notification: silentNotifications,
        ...replyParameters,
	      });
	      return;
	    }

    const keyboard = new InlineKeyboard()
      .text('Confirm & Run', `td:confirm:${draft.id}`)
      .text('Cancel', `td:cancel:${draft.id}`);

    const previewMarkdown = formatTaskDraftPreview({ prompt: text, workspaceRoot, state: 'pending' });
    const previewText = escapeTelegramMarkdownV2(previewMarkdown);

	    await ctx.reply(previewText, {
	      parse_mode: 'MarkdownV2',
	      reply_markup: keyboard,
	      disable_notification: silentNotifications,
      ...replyParameters,
	      link_preview_options: { is_disabled: true },
	    });
	  });

  bot.callbackQuery(/^td:(confirm|cancel):([0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12})$/i, async (ctx) => {
    const userId = await requireUserId(ctx, 'callbackQuery:td');
    if (userId === null) return;
    if (!(await requirePrivateChat(ctx, 'callbackQuery:td'))) return;

    const data = String(ctx.callbackQuery.data ?? '');
    const [prefix, action, draftId] = data.split(':');
    if (prefix !== 'td' || !action || !draftId) {
      await ctx.answerCallbackQuery({ text: '❌ Invalid callback', show_alert: true }).catch(() => undefined);
      return;
    }

    const authUserId = deriveTelegramAuthUserId(userId);

    if (action === 'cancel') {
      const result = cancelTelegramTaskDraft({ authUserId, draftId });
      if (result.status === 'not_found') {
        await ctx.answerCallbackQuery({ text: '❌ Draft not found', show_alert: false }).catch(() => undefined);
        return;
      }
      if (result.status === 'already_approved') {
        await ctx.answerCallbackQuery({ text: '✅ 已入队', show_alert: false }).catch(() => undefined);
        return;
      }
      if (result.status === 'already_cancelled' || result.status === 'cancelled') {
        await ctx.answerCallbackQuery({ text: '🗑️ 已取消', show_alert: false }).catch(() => undefined);
        const draft = getTelegramTaskDraft({ authUserId, draftId });
        const prompt = draft?.bundle?.tasks?.[0]?.prompt ?? '';
        const workspaceRoot = draft?.workspaceRoot ?? (result.status === 'cancelled' ? result.workspaceRoot : '');
        const updated = escapeTelegramMarkdownV2(formatTaskDraftPreview({ prompt, workspaceRoot, state: 'cancelled' }));
        await ctx
          .editMessageText(updated, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } })
          .catch(() => undefined);
        return;
      }
      await ctx.answerCallbackQuery({ text: '❌ 取消失败', show_alert: false }).catch(() => undefined);
      return;
    }

    if (action !== 'confirm') {
      await ctx.answerCallbackQuery({ text: '❌ Unknown action', show_alert: true }).catch(() => undefined);
      return;
    }

    const result = confirmTelegramTaskDraft({ authUserId, draftId });
    if (result.status === 'not_found') {
      await ctx.answerCallbackQuery({ text: '❌ Draft not found', show_alert: false }).catch(() => undefined);
      return;
    }
    if (result.status === 'cancelled') {
      await ctx.answerCallbackQuery({ text: '🗑️ 已取消', show_alert: false }).catch(() => undefined);
      return;
    }
    if (result.status === 'workspace_unavailable') {
      await ctx.answerCallbackQuery({ text: '❌ workspace 不可用，请重新创建草稿', show_alert: true }).catch(() => undefined);
      return;
    }
    if (result.status === 'error') {
      await ctx.answerCallbackQuery({ text: '❌ 入队失败', show_alert: false }).catch(() => undefined);
      return;
    }

    const createdTaskIds = result.createdTaskIds;
	    const updated = (() => {
	      const draft = getTelegramTaskDraft({ authUserId, draftId });
	      const prompt = draft?.bundle?.tasks?.[0]?.prompt ?? '';
	      const workspaceRoot = draft?.workspaceRoot ?? result.workspaceRoot;
	      return escapeTelegramMarkdownV2(formatTaskDraftPreview({ prompt, workspaceRoot, state: "approved", createdTaskIds }));
	    })();

    await ctx.answerCallbackQuery({ text: '✅ 已入队', show_alert: false }).catch(() => undefined);
    await ctx
      .editMessageText(updated, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } })
      .catch(() => undefined);
  });

  // 处理带图片的消息
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption || '请描述这张图片';
    const photos = ctx.message.photo;
    const userId = await requireUserId(ctx, 'message:photo');
    if (userId === null) return;
    const cwd = directoryManager.getUserCwd(userId);

    // 获取最高分辨率的图片
    const photo = photos[photos.length - 1];

    await handleCodexMessage(
      ctx,
      caption,
      sessionManager,
      config.streamUpdateIntervalMs,
      [photo.file_id],
      undefined,
      cwd,
      {
        markNoteEnabled: markStates.get(userId) ?? false,
        silentNotifications,
        replyToMessageId: ctx.message.message_id,
      }
    );
  });

  // 处理文档文件
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || '';
    const userId = await requireUserId(ctx, 'message:document');
    if (userId === null) return;
    const cwd = directoryManager.getUserCwd(userId);

    // 检查文件大小
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await ctx.reply('❌ 文件过大，限制 20MB');
      return;
    }

    await handleCodexMessage(
      ctx,
      caption,
      sessionManager,
      config.streamUpdateIntervalMs,
      undefined,
      doc.file_id,
      cwd,
      {
        markNoteEnabled: markStates.get(userId) ?? false,
        silentNotifications,
        replyToMessageId: ctx.message.message_id,
      }
    );
  });

  // 处理语音消息
  bot.on('message:voice', async (ctx) => {
    const voice = ctx.message.voice;
    const caption = ctx.message.caption || '';
    const userId = await requireUserId(ctx, 'message:voice');
    if (userId === null) return;

    if (voice.file_size && voice.file_size > 20 * 1024 * 1024) {
      await ctx.reply('❌ 文件过大，限制 20MB');
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      if (typeof chatId !== 'number') {
        await ctx.reply('❌ 无法识别 chat.id');
        return;
      }

      const mimeType = typeof voice.mime_type === 'string' ? voice.mime_type : 'audio/ogg';
      const text = await transcribeTelegramVoiceMessage({
        api: ctx.api,
        fileId: voice.file_id,
        mimeType,
        caption,
      });

      const keyboard = new InlineKeyboard().text('Submit', 'vt:submit').text('Discard', 'vt:discard');
      const previewMarkdown = formatTranscriptionPreview({ text, state: "pending" });
      const previewText = escapeTelegramMarkdownV2(previewMarkdown);

      const preview = await ctx.reply(previewText, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
        disable_notification: silentNotifications,
        reply_parameters: { message_id: ctx.message.message_id },
        link_preview_options: { is_disabled: true },
      });

      pendingTranscriptions.add({ chatId, previewMessageId: preview.message_id, text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ 语音识别失败: ${message}`, {
        disable_notification: silentNotifications,
        reply_parameters: { message_id: ctx.message.message_id },
      });
    }
  });

  bot.callbackQuery(/^vt:(submit|discard)$/, async (ctx) => {
    const userId = await requireUserId(ctx, 'callbackQuery:vt');
    if (userId === null) {
      return;
    }

    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number') {
      await ctx.answerCallbackQuery({ text: '❌ 无法识别 chat.id', show_alert: true }).catch(() => undefined);
      return;
    }

    const previewMessageId = ctx.callbackQuery.message?.message_id;
    if (typeof previewMessageId !== 'number') {
      await ctx.answerCallbackQuery({ text: '❌ 无法识别预览消息', show_alert: true }).catch(() => undefined);
      return;
    }

    const data = String(ctx.callbackQuery.data ?? '');
    const action = data.split(':')[1] ?? '';

    if (action === 'discard') {
      const result = pendingTranscriptions.discard({ chatId, previewMessageId });
      if (result.status === 'expired' || result.status === 'missing') {
        await ctx.answerCallbackQuery({ text: '⏱️ 已过期', show_alert: false }).catch(() => undefined);
        return;
      }
      if (result.status === 'already_discarded') {
        await ctx.answerCallbackQuery({ text: '🗑️ 已丢弃', show_alert: false }).catch(() => undefined);
        return;
      }
      if (result.status === 'already_submitted') {
        await ctx.answerCallbackQuery({ text: '✅ 已提交', show_alert: false }).catch(() => undefined);
        return;
      }

      await ctx.answerCallbackQuery({ text: '🗑️ 已丢弃', show_alert: false }).catch(() => undefined);

      const record = pendingTranscriptions.get({ chatId, previewMessageId });
      const text = record?.text ?? '';
      const updated = escapeTelegramMarkdownV2(formatTranscriptionPreview({ text, state: "discarded" }));
      await ctx
        .editMessageText(updated, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } })
        .catch(() => undefined);
      return;
    }

    if (action !== 'submit') {
      await ctx.answerCallbackQuery({ text: '❌ Unknown action', show_alert: true }).catch(() => undefined);
      return;
    }

    if (hasActiveCodexRequest(userId)) {
      await ctx
        .answerCallbackQuery({ text: '⚠️ 已有请求正在执行，请稍后再提交（或用 /esc 中断）', show_alert: false })
        .catch(() => undefined);
      return;
    }

    const record = pendingTranscriptions.get({ chatId, previewMessageId });
    if (!record) {
      await ctx.answerCallbackQuery({ text: '⏱️ 已过期', show_alert: false }).catch(() => undefined);
      return;
    }

    const consume = pendingTranscriptions.consume({ chatId, previewMessageId });
    if (consume.status === 'expired' || consume.status === 'missing') {
      await ctx.answerCallbackQuery({ text: '⏱️ 已过期', show_alert: false }).catch(() => undefined);
      return;
    }
    if (consume.status === 'already_submitted') {
      await ctx.answerCallbackQuery({ text: '✅ 已提交', show_alert: false }).catch(() => undefined);
      return;
    }
    if (consume.status === 'already_discarded') {
      await ctx.answerCallbackQuery({ text: '🗑️ 已丢弃', show_alert: false }).catch(() => undefined);
      return;
    }

    await ctx.answerCallbackQuery({ text: '✅ 已提交', show_alert: false }).catch(() => undefined);

    const updated = escapeTelegramMarkdownV2(formatTranscriptionPreview({ text: consume.text, state: "submitted" }));
    await ctx
      .editMessageText(updated, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } })
      .catch(() => undefined);

    const cwd = directoryManager.getUserCwd(userId);
    await handleCodexMessage(
      ctx,
      consume.text,
      sessionManager,
      config.streamUpdateIntervalMs,
      undefined,
      undefined,
      cwd,
      {
        markNoteEnabled: markStates.get(userId) ?? false,
        silentNotifications,
        replyToMessageId: previewMessageId,
      },
    );
  });

  // 处理普通文本消息 - Codex 对话
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = await requireUserId(ctx, 'message:text');
    if (userId === null) return;

    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const firstToken = trimmed.split(/\s+/)[0] ?? '';
      const withoutSlash = firstToken.slice(1);
      const command = withoutSlash.split('@')[0]?.toLowerCase() ?? '';
      if (command && TELEGRAM_CONTROL_COMMANDS.has(command)) {
        return;
      }
    }

    const cwd = directoryManager.getUserCwd(userId);

    await handleCodexMessage(
      ctx,
      text,
      sessionManager,
      config.streamUpdateIntervalMs,
      undefined,
      undefined,
      cwd,
      {
        markNoteEnabled: markStates.get(userId) ?? false,
        silentNotifications,
        replyToMessageId: ctx.message.message_id,
      }
    );
  });

  // 启动 Bot
  logger.info('Starting long polling...');
  bot.start({
    onStart: () => {
      logger.info('✅ Bot is running!');
    },
  });

  // 优雅退出
  process.once('SIGINT', () => {
    logger.info('Shutting down...');
    sessionManager.destroy();
    bot.stop();
    try {
      closeAllWorkspaceDatabases();
    } catch {
      // ignore
    }
    try {
      closeAllStateDatabases();
    } catch {
      // ignore
    }
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    logger.info('Shutting down...');
    sessionManager.destroy();
    bot.stop();
    try {
      closeAllWorkspaceDatabases();
    } catch {
      // ignore
    }
    try {
      closeAllStateDatabases();
    } catch {
      // ignore
    }
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error('Fatal error', error);
  try {
    closeAllWorkspaceDatabases();
  } catch {
    // ignore
  }
  try {
    closeAllStateDatabases();
  } catch {
    // ignore
  }
  process.exit(1);
});

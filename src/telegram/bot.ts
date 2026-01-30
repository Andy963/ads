import '../utils/logSink.js';
import '../utils/env.js';

import { Bot, type Context } from 'grammy';
import { loadTelegramConfig, validateConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { resolveCodexConfig } from '../codexConfig.js';
import { SessionManager } from './utils/sessionManager.js';
import { DirectoryManager } from './utils/directoryManager.js';
import { handleCodexMessage, interruptExecution } from './adapters/codex.js';
import { cleanupAllTempFiles } from './utils/fileHandler.js';
import { createLogger } from '../utils/logger.js';
import { HttpsProxyAgent } from './utils/proxyAgent.js';
import { getDailyNoteFilePath } from './utils/noteLogger.js';
import { detectWorkspaceFrom } from '../workspace/detector.js';
import { SearchTool } from '../tools/index.js';
import { ensureApiKeys, resolveSearchConfig } from '../tools/search/config.js';
import { formatSearchResults } from '../tools/search/format.js';
import { formatLocalSearchOutput, searchWorkspaceFiles } from '../utils/localSearch.js';
import { runVectorSearch, syncVectorSearch } from '../vectorSearch/run.js';
import { closeAllStateDatabases } from '../state/database.js';
import { closeAllWorkspaceDatabases } from '../storage/database.js';
import { installApiDebugLogging, installSilentReplyMiddleware, parseBooleanFlag } from './botSetup.js';

const logger = createLogger('Bot');
const markStates = new Map<number, boolean>();

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
      { command: 'search', description: '网络搜索（Tavily）' },
      { command: 'vsearch', description: '语义搜索' },
      { command: 'vsearch_sync', description: '手动同步向量索引' },
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
      '/search <query> - 网络搜索（Tavily）\n' +
      '/vsearch <query> - 语义向量搜索（需要配置向量服务）\n' +
      '/vsearch_sync - 手动同步向量索引（Spec, ADR, 历史记录）\n' +
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
      '/search <query> - 网络搜索（Tavily）\n' +
      '/vsearch <query> - 语义向量搜索（需要配置向量服务）\n' +
      '/vsearch_sync - 手动同步向量索引（Spec, ADR, 历史记录）\n' +
      '/esc - 中断当前任务（Agent 保持运行）\n\n' +
      '📁 目录管理：\n' +
      '/pwd - 当前工作目录\n' +
      '/cd <path> - 切换目录\n\n' +
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

  bot.command('search', async (ctx) => {
    const userId = await requireUserId(ctx, '/search');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1);
    if (!args || args.length === 0) {
      await ctx.reply('用法: /search <query>');
      return;
    }
    const query = args.join(' ').trim();
    const config = resolveSearchConfig();
    const missingKeys = ensureApiKeys(config);
    if (missingKeys) {
      const cwd = directoryManager.getUserCwd(userId);
      const workspaceRoot = detectWorkspaceFrom(cwd);
      const local = searchWorkspaceFiles({ workspaceRoot, query });
      const output = formatLocalSearchOutput({ query, ...local });
      await ctx.reply(output, { disable_notification: silentNotifications });
      return;
    }
    try {
      const result = await SearchTool.search({ query }, { config });
      const output = formatSearchResults(query, result);
      await ctx.reply(output, { disable_notification: silentNotifications });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ /search 失败: ${message}`, { disable_notification: silentNotifications });
    }
  });

  bot.command('vsearch', async (ctx) => {
    const userId = await requireUserId(ctx, '/vsearch');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1);
    if (!args || args.length === 0) {
      await ctx.reply('用法: /vsearch <query>');
      return;
    }
    const query = args.join(' ');
    const cwd = directoryManager.getUserCwd(userId);
    const workspaceRoot = detectWorkspaceFrom(cwd);
    const output = await runVectorSearch({ workspaceRoot, query, entryNamespace: 'telegram' });
    const note =
      "ℹ️ 提示：系统会在后台自动用向量召回来补齐 agent 上下文；/vsearch 主要用于手动调试/查看原始召回结果。";
    const decorated = output.startsWith("Vector search results for:") ? `${note}\n\n${output}` : output;
    await ctx.reply(decorated, { disable_notification: silentNotifications });
  });

  bot.command('vsearch_sync', async (ctx) => {
    const userId = await requireUserId(ctx, '/vsearch_sync');
    if (userId === null) return;
    const cwd = directoryManager.getUserCwd(userId);
    const workspaceRoot = detectWorkspaceFrom(cwd);

    await ctx.reply('⏳ 正在同步向量索引...');
    const result = await syncVectorSearch({ workspaceRoot });

    if (result.ok) {
      await ctx.reply(`✅ ${result.message}`, { disable_notification: silentNotifications });
    } else {
      await ctx.reply(`❌ ${result.message}`, { disable_notification: silentNotifications });
    }
  });

  bot.command('cd', async (ctx) => {
    const userId = await requireUserId(ctx, '/cd');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1);

    if (!args || args.length === 0) {
      await ctx.reply('用法: /cd <path>');
      return;
    }

    const path = args.join(' ');
    const prevCwd = directoryManager.getUserCwd(userId);
    const result = directoryManager.setUserCwd(userId, path);

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
      }
    );
  });

  // 处理普通文本消息 - Codex 对话
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = await requireUserId(ctx, 'message:text');
    if (userId === null) return;

    // 跳过其它命令
    if (text.startsWith('/')) {
      return;
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

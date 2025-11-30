import '../utils/logSink.js';

import { Bot, type Context } from 'grammy';
import { loadTelegramConfig, validateConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { resolveCodexConfig } from '../codexConfig.js';
import { SessionManager } from './utils/sessionManager.js';
import { DirectoryManager } from './utils/directoryManager.js';
import { handleCodexMessage, interruptExecution } from './adapters/codex.js';
import { handleAdsCommand } from './adapters/ads.js';
import { cleanupAllTempFiles } from './utils/fileHandler.js';
import { createLogger } from '../utils/logger.js';
import { checkWorkspaceInit } from './utils/workspaceInitChecker.js';
import { parseInlineAdsCommand, parsePlainAdsCommand } from './utils/adsCommand.js';
import { HttpsProxyAgent } from './utils/proxyAgent.js';
import { getDailyNoteFilePath } from './utils/noteLogger.js';
import { initializeWorkspace } from '../workspace/detector.js';
import type { WorkspaceInitStatus } from './utils/workspaceInitChecker.js';
import { escapeTelegramMarkdownV2 } from '../utils/markdown.js';

const logger = createLogger('Bot');
const markStates = new Map<number, boolean>();

const AFFIRMATIVE_RESPONSES = new Set([
  'y',
  'yes',
  'ok',
  'okay',
  'sure',
  '好',
  '好的',
  '好吧',
  '好呀',
  '好啊',
  '好啦',
  '好勒',
  '行',
  '行吧',
  '行啊',
  '行的',
  '可以',
  '确认',
  '确定',
  '是',
  '是的',
  '没问题',
]);

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

function normalizeAffirmativeCandidate(text: string | undefined | null): string {
  if (!text) {
    return '';
  }
  return text
    .trim()
    .replace(/[\u3002。!！?？~～\s]+$/g, '')
    .toLowerCase();
}

function isAffirmativeResponse(text: string | undefined | null): boolean {
  const normalized = normalizeAffirmativeCandidate(text);
  if (!normalized) {
    return false;
  }
  if (AFFIRMATIVE_RESPONSES.has(normalized)) {
    return true;
  }
  return false;
}

function buildWorkspaceInitReminder(status: WorkspaceInitStatus, cwd: string): string {
  const missing = status.missingArtifact ?? 'ADS 必需文件';
  return (
    '⚠️ 当前目录尚未初始化 ADS\n' +
    `📁 目录: ${cwd}\n` +
    `缺少: ${missing}\n` +
    '发送 /ads.init 初始化，或回复 "是" 自动执行。'
  );
}

async function initializeWorkspaceForUser(
  ctx: Context,
  cwd: string,
  userId: number,
  sessionManager: SessionManager,
): Promise<void> {
  const status = checkWorkspaceInit(cwd);
  if (status.initialized) {
    await ctx.reply(`ℹ️ 当前目录已完成初始化: ${cwd}`);
    return;
  }
  try {
    initializeWorkspace(cwd);
    sessionManager.reset(userId);
    await ctx.reply(`✅ 已在 ${cwd} 初始化 ADS 工作空间\n可以继续执行命令或开始对话`);
  } catch (error) {
    await ctx.reply(`❌ 初始化失败: ${(error as Error).message}`);
  }
}

async function main() {
  logger.info('Starting ADS Telegram Bot...');

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

  // 启动时恢复工作目录（单用户）
  const userId = config.allowedUsers[0];
  const savedState = sessionManager.getSavedState(userId);
  if (savedState?.cwd) {
    const result = directoryManager.setUserCwd(userId, savedState.cwd);
    if (result.success) {
      logger.info(`[WorkspacePersistence] Restored cwd: ${savedState.cwd}`);
    } else {
      logger.warn(
        `[WorkspacePersistence] Failed to restore cwd from ${savedState.cwd}: ${result.error}`,
      );
      // 如果恢复失败，使用默认目录
      const defaultDir = config.allowedDirs[0];
      directoryManager.setUserCwd(userId, defaultDir);
      // 同步到 SessionManager
      sessionManager.setUserCwd(userId, defaultDir);
    }
  } else {
    logger.info('[WorkspacePersistence] No saved cwd found, using default');
    // 设置默认目录
    const defaultDir = config.allowedDirs[0];
    directoryManager.setUserCwd(userId, defaultDir);
    sessionManager.setUserCwd(userId, defaultDir);
  }

  // 创建 Bot 实例
  const clientConfig = config.proxyUrl
    ? {
        baseFetchConfig: {
          agent: new HttpsProxyAgent(config.proxyUrl),
        },
      }
    : undefined;

  const bot = new Bot(config.botToken, clientConfig ? { client: clientConfig } : undefined);

  // Debug: Log all API calls to see exactly what's being sent
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage' || method === 'sendDocument' || method === 'sendPhoto') {
      const p = payload as Record<string, unknown>;
      logger.info(`[API Debug] ${method} disable_notification=${p.disable_notification} (type: ${typeof p.disable_notification})`);
    }
    return prev(method, payload, signal);
  });

  // 根据配置静音：所有 ctx.reply 默认禁用通知，除非调用方显式覆盖
  bot.use(async (ctx, next) => {
    const originalReply = ctx.reply.bind(ctx);
    const wrappedReply = (text: Parameters<Context["reply"]>[0], other?: Parameters<Context["reply"]>[1]) => {
      if (!silentNotifications) {
        return originalReply(text as never, other as never);
      }
      if (other && Object.prototype.hasOwnProperty.call(other, 'disable_notification')) {
        return originalReply(text as never, other as never);
      }
      const merged = { ...(other ?? {}), disable_notification: true };
      return originalReply(text as never, merged as never);
    };
    ctx.reply = wrappedReply as Context["reply"];
    await next();
  });

  // 注册中间件
  bot.use(createAuthMiddleware(config.allowedUsers));
  bot.use(createRateLimitMiddleware(config.maxRequestsPerMinute));

  // 注册命令列表（显示在 Telegram 输入框）
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: '欢迎信息' },
      { command: 'help', description: '命令帮助' },
      { command: 'ads', description: 'ADS 命令' },
      { command: 'status', description: '系统状态' },
      { command: 'esc', description: '中断当前任务' },
      { command: 'reset', description: '开始新对话' },
      { command: 'resume', description: '恢复之前的对话' },
      { command: 'mark', description: '记录对话到笔记' },
      { command: 'model', description: '查看/切换模型' },
      { command: 'agent', description: '查看/切换代理' },
      { command: 'pwd', description: '当前目录' },
      { command: 'cd', description: '切换目录' },
    ]);
    logger.info('Telegram commands registered');
  } catch (error) {
    logger.warn(`Failed to register Telegram commands (will continue): ${(error as Error).message}`);
  }

  // 基础命令
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 欢迎使用 ADS Telegram Bot!\n\n' +
      '可用命令：\n' +
      '/help - 查看所有命令\n' +
      '/status - 查看系统状态\n' +
      '/reset - 重置会话\n' +
      '/mark - 切换对话标记，记录到当天 note\n' +
      '/pwd - 查看当前目录\n' +
      '/cd <path> - 切换目录\n' +
      '/agent [name] - 查看或切换可用代理\n' +
      '使用 /ads.status、/ads.new、/ads.commit 等命令执行 ADS 操作\n\n' +
      '直接发送文本与 Codex 对话'
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '📖 ADS Telegram Bot 命令列表\n\n' +
      '🔧 系统命令：\n' +
      '/start - 欢迎信息\n' +
      '/help - 显示此帮助\n' +
      '/status - 系统状态\n' +
      '/reset - 重置会话（开始新对话）\n' +
      '/resume - 恢复之前的对话\n' +
      '/mark - 切换对话标记（记录每日 note）\n' +
      '/model [name] - 查看/切换模型\n' +
      '/agent [name] - 查看/切换代理\n' +
      '/esc - 中断当前任务（Agent 保持运行）\n\n' +
      '📁 目录管理：\n' +
      '/pwd - 当前工作目录\n' +
      '/cd <path> - 切换目录\n\n' +
      '⚙️ ADS 命令：\n' +
      '/ads.status - 工作流状态\n' +
      '/ads.new <title> - 创建工作流\n' +
      '/ads.commit <step> - 定稿步骤\n\n' +
      '💬 对话：\n' +
      '直接发送消息与 Codex AI 对话\n' +
      '发送图片可让 Codex 分析图像\n' +
      '发送文件让 Codex 处理文件\n' +
      '执行过程中可用 /esc 中断当前任务'
    );
  });

  bot.command('status', async (ctx) => {
    const userId = ctx.from!.id;
    const stats = sessionManager.getStats();
    const cwd = directoryManager.getUserCwd(userId);
    const orchestrator = sessionManager.getOrCreate(userId, cwd, false);
    const currentModel = sessionManager.getUserModel(userId);
    const agentLabel = sessionManager.getActiveAgentLabel(userId) || 'Codex';
    const agentLines = orchestrator
      .listAgents()
      .map((entry) => {
        const marker = entry.metadata.id === orchestrator.getActiveAgentId() ? '•' : '○';
        const state = entry.status.ready ? '可用' : entry.status.error ?? '未配置';
        return `${marker} ${entry.metadata.name} (${entry.metadata.id}) - ${state}`;
      })
      .join('\n');
    
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
      `🧠 当前代理: ${agentLabel}\n` +
      `📁 当前目录: ${cwd}\n\n` +
      `代理列表：\n${agentLines || '（暂无可用代理）'}`
    );
  });

  bot.command('reset', async (ctx) => {
    const userId = ctx.from!.id;
    sessionManager.reset(userId);
    await ctx.reply('✅ 代理会话已重置，新对话已开始');
  });

  bot.command('resume', async (ctx) => {
    const userId = ctx.from!.id;
    
    if (!sessionManager.hasSavedThread(userId)) {
      await ctx.reply('❌ 没有保存的对话可恢复');
      return;
    }

    const threadId = sessionManager.getSavedThreadId(userId);
    sessionManager.reset(userId); // 清空当前 session
    
    // 创建新 session 并恢复 thread
    sessionManager.getOrCreate(userId, directoryManager.getUserCwd(userId), true);
    
    await ctx.reply(`✅ 已恢复之前的对话 (Thread ID: ${threadId?.slice(0, 8)}...)`);
  });

  bot.command('mark', async (ctx) => {
    const userId = ctx.from!.id;
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

  bot.command('model', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message?.text.split(' ').slice(1) || [];
    
    if (args.length === 0) {
      // 查看当前模型
      const currentModel = sessionManager.getUserModel(userId);
      const defaultModel = sessionManager.getDefaultModel();
      
      await ctx.reply(
        `🤖 模型设置\n\n` +
        `当前模型: ${currentModel}\n` +
        `默认模型: ${defaultModel}\n\n` +
        `使用 /model <name> 切换模型\n` +
        `注意：切换模型会重置当前对话`
      );
    } else {
      // 切换模型
      const newModel = args.join(' ').trim();
      if (!newModel) {
        await ctx.reply('❌ 请提供模型名称');
        return;
      }
      
      sessionManager.setUserModel(userId, newModel);
      await ctx.reply(`✅ 已切换到模型: ${newModel}\n会话已重置，可以开始新对话`);
    }
  });

  bot.command('agent', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message?.text.split(' ').slice(1) || [];
    const cwd = directoryManager.getUserCwd(userId);
    const orchestrator = sessionManager.getOrCreate(userId, cwd, false);

    if (args.length === 0) {
      const agents = orchestrator.listAgents();
      if (!agents.length) {
        await ctx.reply('❌ 暂无可用代理');
        return;
      }
      const lines = agents
        .map((entry) => {
          const marker = entry.metadata.id === orchestrator.getActiveAgentId() ? '•' : '○';
          const state = entry.status.ready ? '可用' : entry.status.error ?? '未配置';
          return `${marker} ${entry.metadata.name} (${entry.metadata.id}) - ${state}`;
        })
        .join('\n');
      await ctx.reply(
        `🤖 可用代理：\n${lines}\n\n` +
        `使用 /agent <id> 切换代理，如 /agent claude。\n` +
        `需要 Claude 协助时，请在消息中插入 <<<agent.claude ...>>> 指令块描述任务。`
      );
      return;
    }

    const normalized = args[0].toLowerCase();
    if (normalized === 'auto') {
      await ctx.reply('❌ 自动模式已停用，需要 Claude 时请手动插入 <<<agent.claude ...>>> 指令块。');
      return;
    }
    if (normalized === 'manual') {
      await ctx.reply('ℹ️ 当前已经是手动协作模式，可直接继续使用。');
      return;
    }

    const result = sessionManager.switchAgent(userId, args[0]);
    await ctx.reply(result.message);
  });

  bot.command('esc', async (ctx) => {
    const userId = ctx.from!.id;
    const interrupted = interruptExecution(userId);

    if (interrupted) {
      await ctx.reply('⛔️ 已中断当前任务\n✅ Agent 仍在运行，可以发送新指令');
    } else {
      await ctx.reply('ℹ️ 当前没有正在执行的任务');
    }
  });

  bot.command('pwd', async (ctx) => {
    const userId = ctx.from!.id;
    const cwd = directoryManager.getUserCwd(userId);
    await ctx.reply(`📁 当前工作目录: ${cwd}`);
  });

  bot.command('cd', async (ctx) => {
    const userId = ctx.from!.id;
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

      const initStatus = checkWorkspaceInit(newCwd);
      let replyMessage = `✅ 已切换到: ${newCwd}`;
      if (prevCwd !== newCwd) {
        replyMessage += `\n💡 代理上下文已切换到新目录`;
      } else {
        replyMessage += `\nℹ️ 已在相同目录，无需重置会话`;
      }

      if (!initStatus.initialized) {
        const missing = initStatus.missingArtifact ?? "ADS 必需文件";
        replyMessage += `\n⚠️ 检测到该目录尚未初始化 ADS（缺少 ${missing}）。`;
        logger.warn(
          `[Telegram][WorkspaceInit] path=${newCwd} missing=${missing}${
            initStatus.details ? ` details=${initStatus.details}` : ""
          }`,
        );

        await ctx.reply(replyMessage);
        await ctx.reply(
          '是否初始化此目录？这将创建 .ads 目录、配置文件和数据库。\n\n' +
          '回复 "是" 或 "y" 确认初始化，其他任何回复将取消。'
        );
        // Note: 用户后续回复 (如 "是") 将由 Telegram Bot 自动触发 /ads.init
      } else {
        await ctx.reply(replyMessage);
      }
    } else {
      await ctx.reply(`❌ ${result.error}`);
    }
  });

  bot.command('ads', async (ctx) => {
    const inlineArgs = parseInlineAdsCommand(ctx.message?.text);
    if (inlineArgs) {
      const userId = ctx.from!.id;
      const cwd = directoryManager.getUserCwd(userId);
      const subcommand = inlineArgs[0];
      if (subcommand === 'init') {
        await initializeWorkspaceForUser(ctx, cwd, userId, sessionManager);
        return;
      }
      const initStatus = checkWorkspaceInit(cwd);
      if (!initStatus.initialized) {
        await ctx.reply(buildWorkspaceInitReminder(initStatus, cwd));
        return;
      }
      await handleAdsCommand(ctx, inlineArgs, { workspacePath: cwd });
      return;
    }

    const helpText =
      'ℹ️ ADS 命令已统一为点号形式，请使用以下格式：\n\n' +
      '/ads.status - 查看工作流状态\n' +
      '/ads.new <title> - 创建工作流\n' +
      '/ads.commit <step> - 定稿步骤\n\n' +
      '请不要使用 `/ads status` 或 `/ads new` 等空格形式。';
    const escaped = escapeTelegramMarkdownV2(helpText);
    await ctx.reply(escaped, { parse_mode: 'MarkdownV2' });
  });

  // 处理带图片的消息
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption || '请描述这张图片';
    const photos = ctx.message.photo;
    const userId = ctx.from!.id;
    const cwd = directoryManager.getUserCwd(userId);
    const initStatus = checkWorkspaceInit(cwd);
    if (!initStatus.initialized) {
      await ctx.reply(buildWorkspaceInitReminder(initStatus, cwd));
      return;
    }
    
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
    const userId = ctx.from!.id;
    const cwd = directoryManager.getUserCwd(userId);
    const initStatus = checkWorkspaceInit(cwd);
    if (!initStatus.initialized) {
      await ctx.reply(buildWorkspaceInitReminder(initStatus, cwd));
      return;
    }
    
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
    const userId = ctx.from!.id;
    const cwd = directoryManager.getUserCwd(userId);
    const initStatus = checkWorkspaceInit(cwd);

    const handleWorkspaceInitCommand = async () => {
      await initializeWorkspaceForUser(ctx, cwd, userId, sessionManager);
    };

    const inlineAdsArgs = parseInlineAdsCommand(text);
    if (inlineAdsArgs) {
      const subcommand = inlineAdsArgs[0];
      if (subcommand === 'init') {
        await handleWorkspaceInitCommand();
        return;
      }
      if (!initStatus.initialized) {
        await ctx.reply(buildWorkspaceInitReminder(initStatus, cwd));
        return;
      }
      await handleAdsCommand(ctx, inlineAdsArgs, { workspacePath: cwd });
      return;
    }

    const plainAdsArgs = parsePlainAdsCommand(text);
    if (plainAdsArgs) {
      const subcommand = plainAdsArgs[0];
      if (subcommand === 'init') {
        await handleWorkspaceInitCommand();
        return;
      }
      if (!initStatus.initialized) {
        await ctx.reply(buildWorkspaceInitReminder(initStatus, cwd));
        return;
      }
      await handleAdsCommand(ctx, plainAdsArgs, { workspacePath: cwd });
      return;
    }

    // 跳过其它命令
    if (text.startsWith('/')) {
      return;
    }

    if (!initStatus.initialized) {
      if (isAffirmativeResponse(text)) {
        await handleWorkspaceInitCommand();
      } else {
        await ctx.reply(buildWorkspaceInitReminder(initStatus, cwd));
      }
      return;
    }

    // 检查是否有保存的对话但当前没有活跃 session
    // 如果有保存的 thread 且当前没有 session，自动恢复
    const hasActiveSession = sessionManager.hasSession(userId);
    
    if (sessionManager.hasSavedThread(userId) && !hasActiveSession) {
      const threadId = sessionManager.getSavedThreadId(userId);
      
      // 自动恢复之前的对话
      sessionManager.getOrCreate(userId, directoryManager.getUserCwd(userId), true);
      
      await ctx.reply(
        `💡 自动恢复之前的对话 (Thread ID: ${threadId?.slice(0, 8)}...)\n\n` +
        '💬 正在处理您的消息...\n\n' +
        '提示：使用 /reset 可以开始新对话'
      );
    }

    await handleCodexMessage(
      ctx,
      text,
      sessionManager,
      config.streamUpdateIntervalMs,
      undefined,
      undefined,
      directoryManager.getUserCwd(userId),
      {
        markNoteEnabled: markStates.get(userId) ?? false,
        silentNotifications,
      }
    );
  });

  // 启动 Bot
  console.log('[Bot] Starting long polling...');
  bot.start({
    onStart: () => {
      console.log('[Bot] ✅ Bot is running!');
    },
  });

  // 优雅退出
  process.once('SIGINT', () => {
    console.log('\n[Bot] Shutting down...');
    sessionManager.destroy();
    bot.stop();
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    console.log('\n[Bot] Shutting down...');
    sessionManager.destroy();
    bot.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[Bot] Fatal error:', error);
  process.exit(1);
});

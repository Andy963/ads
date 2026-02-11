import '../utils/logSink.js';
import '../utils/env.js';

import { Bot, type Context } from 'grammy';
import path from 'node:path';
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
import { resolveAdsStateDir } from '../workspace/adsPaths.js';
import { formatLocalSearchOutput, searchWorkspaceFiles } from '../utils/localSearch.js';
import { formatTavilySearchResults, hasTavilyApiKey, runTavilyCli } from '../utils/tavilySkillCli.js';
import { runVectorSearch, syncVectorSearch } from '../vectorSearch/run.js';
import { closeAllStateDatabases } from '../state/database.js';
import { listPreferences, setPreference, deletePreference } from '../memory/soul.js';
import { closeAllWorkspaceDatabases } from '../storage/database.js';
import { installApiDebugLogging, installSilentReplyMiddleware, parseBooleanFlag } from './botSetup.js';
import { runBootstrapLoop } from '../bootstrap/bootstrapLoop.js';
import { CodexBootstrapAgentRunner } from '../bootstrap/agentRunner.js';
import { BwrapSandbox, NoopSandbox } from '../bootstrap/sandbox.js';
import { normalizeBootstrapProjectRef } from '../bootstrap/projectId.js';

const logger = createLogger('Bot');
const markStates = new Map<number, boolean>();
const bootstrapAbortControllers = new Map<number, AbortController>();

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
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

function looksLikeGitUrl(value: string): boolean {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return true;
  if (trimmed.startsWith('git@')) return true;
  if (/^[a-zA-Z0-9._-]+@[^:]+:.+/.test(trimmed)) return true;
  if (trimmed.startsWith('ssh://')) return true;
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
      { command: 'bootstrap', description: '自举运行（bootstrap loop）' },
      { command: 'search', description: '网络搜索（Tavily）' },
      { command: 'vsearch', description: '语义搜索' },
      { command: 'vsearch_sync', description: '手动同步向量索引' },
      { command: 'pref', description: '管理偏好设置' },
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
      '/pref - 管理偏好设置（长期记忆）\n' +
      '/pwd - 查看当前目录\n' +
      '/cd <path> - 切换目录\n' +
      '/bootstrap [--soft] <repoPath|gitUrl> <goal...> - 自举闭环\n\n' +
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
      '/bootstrap [--soft] <repoPath|gitUrl> <goal...> - 自举闭环\n' +
      '/search <query> - 网络搜索（Tavily）\n' +
      '/vsearch <query> - 语义向量搜索（需要配置向量服务）\n' +
      '/vsearch_sync - 手动同步向量索引（Spec, ADR, 历史记录）\n' +
      '/pref [list|add|del] - 管理偏好设置（长期记忆）\n' +
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
    const bootstrapController = bootstrapAbortControllers.get(userId);
    if (bootstrapController) {
      try {
        bootstrapController.abort();
      } catch {
        // ignore
      }
      bootstrapAbortControllers.delete(userId);
    }

    if (interrupted || bootstrapController) {
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
    if (!hasTavilyApiKey()) {
      const cwd = directoryManager.getUserCwd(userId);
      const workspaceRoot = detectWorkspaceFrom(cwd);
      const local = searchWorkspaceFiles({ workspaceRoot, query });
      const output = formatLocalSearchOutput({ query, ...local });
      await ctx.reply(output, { disable_notification: silentNotifications });
      return;
    }
    try {
      const result = await runTavilyCli({ cmd: 'search', query, maxResults: 5 });
      const output = formatTavilySearchResults(query, result.json);
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

  bot.command('pref', async (ctx) => {
    const userId = await requireUserId(ctx, '/pref');
    if (userId === null) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const sub = args[0]?.toLowerCase();
    const cwd = directoryManager.getUserCwd(userId);

    if (!sub || sub === 'list') {
      const prefs = listPreferences(cwd);
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
      setPreference(cwd, key, value);
      await ctx.reply(`✅ 偏好已保存: **${key}** = ${value}`);
      return;
    }

    if (sub === 'del' || sub === 'delete' || sub === 'rm') {
      const key = args[1];
      if (!key) {
        await ctx.reply('用法: /pref del <key>');
        return;
      }
      const deleted = deletePreference(cwd, key);
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

  bot.command('bootstrap', async (ctx) => {
    const userId = await requireUserId(ctx, '/bootstrap');
    if (userId === null) return;
    if (bootstrapAbortControllers.has(userId)) {
      await ctx.reply('⚠️ 已有 bootstrap 正在执行，请等待完成或使用 /esc 中断', { disable_notification: silentNotifications });
      return;
    }
    const rawArgs = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    if (rawArgs.length === 0) {
      await ctx.reply('用法: /bootstrap [--soft] [--no-install] [--no-network] [--max-iterations=N] [--model=MODEL] <repoPath|gitUrl> <goal...>');
      return;
    }

    const params: Record<string, string> = {};
    const positional: string[] = [];
    let softSandbox = false;
    let allowInstallDeps = true;
    let allowNetwork = true;
    let enableReview = true;
    let reviewSpecified = false;
    for (const token of rawArgs) {
      if (token === '--soft') {
        softSandbox = true;
        continue;
      }
      if (token === '--no-install') {
        allowInstallDeps = false;
        continue;
      }
      if (token === '--no-network') {
        allowNetwork = false;
        continue;
      }
      if (token === '--no-review') {
        enableReview = false;
        reviewSpecified = true;
        continue;
      }
      if (token === '--review') {
        enableReview = true;
        reviewSpecified = true;
        continue;
      }
      if (token.startsWith('--')) {
        const eqIndex = token.indexOf('=');
        if (eqIndex > -1) {
          const key = token.slice(2, eqIndex);
          const value = token.slice(eqIndex + 1);
          params[key] = value;
        } else {
          params[token.slice(2)] = 'true';
        }
        continue;
      }
      positional.push(token.replace(/^['"]|['"]$/g, ''));
    }

    const projectRef = (params.repo ?? params.project ?? positional.shift() ?? '').trim();
    const goal = (params.goal ?? positional.join(' ')).trim();
    if (!projectRef) {
      await ctx.reply('❌ 缺少 repoPath/gitUrl。用法: /bootstrap <repoPath|gitUrl> <goal...>', { disable_notification: silentNotifications });
      return;
    }
    if (!goal) {
      await ctx.reply('❌ 缺少 goal。用法: /bootstrap <repoPath|gitUrl> <goal...>', { disable_notification: silentNotifications });
      return;
    }

    const maxIterationsRaw = params['max-iterations'] ?? params.max_iterations ?? params.maxIterations;
    const maxIterationsParsed = maxIterationsRaw ? Number.parseInt(maxIterationsRaw, 10) : 10;
    const maxIterations = Number.isFinite(maxIterationsParsed) ? Math.max(1, Math.min(10, maxIterationsParsed)) : 10;
    const model = params.model ? String(params.model).trim() : undefined;
    const reviewRoundsRaw = params['review-rounds'] ?? params.review_rounds ?? params.reviewRounds;
    const reviewRoundsParsed = reviewRoundsRaw ? Number.parseInt(reviewRoundsRaw, 10) : 2;
    const reviewRounds = Number.isFinite(reviewRoundsParsed) ? Math.max(1, Math.min(2, reviewRoundsParsed)) : 2;
    const reviewModel = params['review-model'] ? String(params['review-model']).trim() : undefined;

    if (softSandbox && !reviewSpecified) {
      enableReview = false;
    }

    const cwd = directoryManager.getUserCwd(userId);
    const project = looksLikeGitUrl(projectRef)
      ? ({ kind: 'git_url', value: projectRef } as const)
      : (() => {
          const resolved = path.resolve(cwd, projectRef);
          if (!directoryManager.validatePath(resolved)) {
            const allowed = directoryManager.getAllowedDirs().join('\n');
            throw new Error(`目录不在白名单内。允许的目录：\n${allowed}`);
          }
          return { kind: 'local_path', value: resolved } as const;
        })();

    const normalizedProject = normalizeBootstrapProjectRef(project);
    const stateDir = resolveAdsStateDir();
    const bootstrapRoot = path.join(stateDir, 'bootstraps', normalizedProject.projectId);
    const hardSandbox = !softSandbox;
    const sandbox = hardSandbox
      ? new BwrapSandbox({ rootDir: bootstrapRoot, allowNetwork })
      : new NoopSandbox();
    const agentRunner = new CodexBootstrapAgentRunner({ sandbox, model: model && model.length > 0 ? model : undefined });

    const controller = new AbortController();
    bootstrapAbortControllers.set(userId, controller);

    await ctx.reply(`⏳ bootstrap started (sandbox=${hardSandbox ? 'hard' : 'soft'})`, { disable_notification: silentNotifications });

    try {
      const result = await runBootstrapLoop(
        {
          project: normalizedProject.project,
          goal,
          maxIterations,
          allowNetwork,
          allowInstallDeps,
          requireHardSandbox: hardSandbox,
          sandbox: { backend: hardSandbox ? 'bwrap' : 'none' },
          review: { enabled: enableReview, maxRounds: reviewRounds, model: reviewModel && reviewModel.length > 0 ? reviewModel : undefined },
        },
        {
          agentRunner,
          signal: controller.signal,
          hooks: {
            async onStarted(bootstrapCtx) {
              const lines = [
                `bootstrap worktree ready runId=${bootstrapCtx.runId}`,
                `worktree: ${bootstrapCtx.worktreeDir}`,
                `artifacts: ${bootstrapCtx.artifactsDir}`,
                `branch: ${bootstrapCtx.branchName}`,
              ];
              await ctx.reply(lines.join('\n'), { disable_notification: silentNotifications });
            },
            async onIteration(progress) {
              const testState = progress.test.summary === '(skipped)' ? 'skipped' : progress.test.ok ? 'ok' : 'fail';
              const line = `iter=${progress.iteration} ok=${progress.ok} lint=${progress.lint.ok ? 'ok' : 'fail'} test=${testState} strategy=${progress.strategy}`;
              await ctx.reply(line, { disable_notification: silentNotifications });
            },
          },
        },
      );

      const artifactsDir = path.dirname(result.lastReportPath);
      const derivedRunId = path.basename(artifactsDir);
      const derivedBootstrapRoot = path.resolve(artifactsDir, '..', '..');
      const worktreeDir = path.join(derivedBootstrapRoot, 'worktrees', derivedRunId);

      const lines: string[] = [];
      lines.push(`✅ bootstrap finished ok=${result.ok} iterations=${result.iterations} strategyChanges=${result.strategyChanges}`);
      lines.push(`runId: ${derivedRunId}`);
      lines.push(`worktree: ${worktreeDir}`);
      lines.push(`artifacts: ${artifactsDir}`);
      if (result.finalBranch) {
        lines.push(`branch: ${result.finalBranch}`);
      }
      if (result.finalCommit) {
        lines.push(`commit: ${result.finalCommit}`);
      }
      lines.push(`report: ${result.lastReportPath}`);
      await ctx.reply(lines.join('\n'), { disable_notification: silentNotifications });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ bootstrap failed: ${message}`, { disable_notification: silentNotifications });
    } finally {
      bootstrapAbortControllers.delete(userId);
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

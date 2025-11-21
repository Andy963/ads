import fs from 'node:fs';
import path from 'node:path';

import { GrammyError, type Context } from 'grammy';
import type { Input, CommandExecutionItem } from '@openai/codex-sdk';
import type { SessionManager } from '../utils/sessionManager.js';
import type { AgentEvent } from '../../codex/events.js';
import { downloadTelegramImage, cleanupImages } from '../utils/imageHandler.js';
import { downloadTelegramFile, cleanupFiles, uploadFileToTelegram } from '../utils/fileHandler.js';
import { processUrls } from '../utils/urlHandler.js';
import { InterruptManager } from '../utils/interruptManager.js';
import { escapeTelegramMarkdown } from '../../utils/markdown.js';
import { injectDelegationGuide, resolveDelegations } from '../../agents/delegation.js';
import {
  CODEX_THREAD_RESET_HINT,
  CodexThreadCorruptedError,
  shouldResetThread,
} from '../../codex/errors.js';

// 全局中断管理器
const interruptManager = new InterruptManager();

function chunkMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  let openFence: string | null = null;

  const appendLine = (line: string) => {
    current = current ? `${current}\n${line}` : line;
  };

  const flushChunk = () => {
    if (!current.trim()) {
      current = '';
      return;
    }
    chunks.push(current);
    current = '';
  };

  for (const line of lines) {
    const prospective = current ? current.length + 1 + line.length : line.length;
    if (prospective + (openFence ? 4 : 0) > maxLen && current) {
      if (openFence) {
        current += '\n```';
      }
      flushChunk();
      if (openFence) {
        current = openFence;
      }
    }

    appendLine(line);

    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      if (openFence) {
        openFence = null;
      } else {
        const fence = trimmed.match(/^```[^\s]*?/);
        openFence = fence ? fence[0] : '```';
      }
    }
  }

  if (openFence) {
    current += '\n```';
  }
  flushChunk();
  return chunks;
}

function truncateForStatus(text: string, limit = 96): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit - 1)}…`;
}

export async function handleCodexMessage(
  ctx: Context,
  text: string,
  sessionManager: SessionManager,
  _streamUpdateIntervalMs: number,
  imageFileIds?: string[],
  documentFileId?: string,
  cwd?: string
) {
  const userId = ctx.from!.id;
  const workspaceRoot = cwd ? path.resolve(cwd) : process.cwd();
  const adapterLogDir = path.join(workspaceRoot, '.ads', 'logs');
  const adapterLogFile = path.join(adapterLogDir, 'telegram-bot.log');
  let logDirReady = false;

  const logWarning = (message: string, error?: unknown) => {
    const timestamp = new Date().toISOString();
    const detail = error
      ? error instanceof Error
        ? error.stack ?? error.message
        : String(error)
      : '';
    try {
      if (!logDirReady) {
        fs.mkdirSync(adapterLogDir, { recursive: true });
        logDirReady = true;
      }
      fs.appendFileSync(
        adapterLogFile,
        `${timestamp} WARN ${message}${detail ? ` | ${detail}` : ''}\n`,
      );
    } catch (fileError) {
      console.warn('[CodexAdapter] Failed to write adapter log:', fileError);
    }
    console.warn(message, error);
  };

  // 检查是否有活跃请求
  if (interruptManager.hasActiveRequest(userId)) {
    await ctx.reply('⚠️ 已有请求正在执行，请等待完成或使用 /stop 中断');
    return;
  }

  const session = sessionManager.getOrCreate(userId, cwd);
  const agentMode = sessionManager.getAgentMode(userId);
  const activeAgentLabel = sessionManager.getActiveAgentLabel(userId) || 'Codex';

  const saveThreadIdIfNeeded = () => {
    const threadId = session.getThreadId();
    if (threadId) {
      sessionManager.saveThreadId(userId, threadId);
    }
  };

  // 尝试获取或创建 logger（如果已有 threadId）
  let logger = sessionManager.ensureLogger(userId);

  // 注册请求
  const signal = interruptManager.registerRequest(userId).signal;

  const STATUS_MESSAGE_LIMIT = 3600; // Telegram 限 4096，预留安全空间
  const sentMsg = await ctx.reply(`💭 [${activeAgentLabel}] 开始处理...`, { disable_notification: true });
  let statusMessageId = sentMsg.message_id;
  let statusMessageText = sentMsg.text ?? '💭 开始处理...';
  let statusUpdatesClosed = false;
  let rateLimitUntil = 0;
  let eventQueue: Promise<void> = Promise.resolve();

  const PHASE_ICON: Partial<Record<AgentEvent['phase'], string>> = {
    analysis: '💭',
    command: '⚙️',
    editing: '✏️',
    tool: '🔧',
    responding: '🗣️',
    completed: '✅',
    error: '❌',
    connection: '📡',
  };

  const PHASE_FALLBACK: Partial<Record<AgentEvent['phase'], string>> = {
    analysis: '分析中',
    command: '执行命令',
    editing: '编辑文件',
    tool: '调用工具',
    responding: '生成回复',
    completed: '已完成',
    error: '错误',
    connection: '网络状态',
  };

  function indent(text: string): string {
    return text
      .split('\n')
      .map((line) => `  ${escapeTelegramMarkdown(line)}`)
      .join('\n');
  }

  function formatCodeBlock(text: string): string {
    const safe = text.replace(/```/g, '`​``');
    return ['```', safe || '\u200b', '```'].join('\n');
  }

  function truncateCommandText(text: string, maxLines = 3): { text: string; truncated: boolean } {
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines) {
      return { text, truncated: false };
    }
    const kept = lines.slice(0, maxLines);
    kept[kept.length - 1] = `${kept[kept.length - 1]} …`;
    return { text: kept.join('\n'), truncated: true };
  }

  function buildCommandStatusEntry(rawItem: CommandExecutionItem, fallbackDetail?: string): string | null {
    const commandLine = (typeof rawItem.command === 'string' && rawItem.command.trim())
      ? rawItem.command.trim()
      : (fallbackDetail?.trim() ?? '');
    if (!commandLine) {
      return null;
    }
    const exitText = rawItem.exit_code === undefined ? '' : ` (exit ${rawItem.exit_code})`;
    const { text: truncatedCommand, truncated } = truncateCommandText(commandLine, 3);
    const withExit = `${truncatedCommand}${exitText}`;
    const blockBody = truncated
      ? `${withExit}\n... (命令已截断至 3 行)`
      : withExit;
    return formatCodeBlock(blockBody);
  }

  interface StatusEntry {
    text: string;
    silent: boolean;
  }

  function getCommandExecutionItem(rawEvent: AgentEvent['raw']): CommandExecutionItem | null {
    if (
      rawEvent.type === 'item.started' ||
      rawEvent.type === 'item.updated' ||
      rawEvent.type === 'item.completed'
    ) {
      const item = rawEvent.item;
      if (item.type === 'command_execution') {
        return item;
      }
    }
    return null;
  }

  function formatStatusEntry(event: AgentEvent): StatusEntry | null {
    if (event.phase === 'completed') {
      return null;
    }
    if (event.phase === 'analysis' && event.title === '开始处理请求') {
      return null;
    }

    const icon = PHASE_ICON[event.phase] ?? '💬';
    const rawTitle = event.title || PHASE_FALLBACK[event.phase] || '处理中';
    const safeTitle = escapeTelegramMarkdown(rawTitle);
    const lines: string[] = [`${icon} ${safeTitle}`];

    if (event.detail && event.phase !== 'command') {
      if (event.phase === 'boot' && event.detail.startsWith('thread#')) {
        lines.push(`> ${escapeTelegramMarkdown(event.detail)}`);
      } else {
        const detail = event.detail.length > 500 ? `${event.detail.slice(0, 497)}...` : event.detail;
        lines.push(indent(detail));
      }
    }

    let silent = false;
    const commandItem = getCommandExecutionItem(event.raw);
    if (commandItem) {
      const commandBlock = buildCommandStatusEntry(commandItem, event.detail);
      if (commandBlock) {
        lines.push(commandBlock);
        silent = true;
      }
    }

    return {
      text: lines.join('\n'),
      silent,
    };
  }

  async function editStatusMessage(text: string): Promise<void> {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
          await ctx.api.editMessageText(ctx.chat!.id, statusMessageId, text, {
            parse_mode: 'Markdown',
          });
          rateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 400 && error.description?.includes('message is not modified')) {
        return;
      }
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        logWarning(`[Telegram] Status update rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await editStatusMessage(text);
      } else {
        logWarning('[CodexAdapter] Failed to edit status message', error);
      }
    }
  }

  async function sendNewStatusMessage(initialText: string, silent: boolean): Promise<void> {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      const newMsg = await ctx.reply(initialText, {
        parse_mode: 'Markdown',
        disable_notification: silent,
      });
      statusMessageId = newMsg.message_id;
      statusMessageText = initialText;
      rateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        logWarning(`[Telegram] Sending status rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await sendNewStatusMessage(initialText, silent);
      } else {
        logWarning('[CodexAdapter] Failed to send status message', error);
      }
    }
  }

  async function appendStatusEntry(entry: StatusEntry): Promise<void> {
    if (!entry.text) {
      return;
    }
    const trimmed = entry.text.trimEnd();
    const candidate = statusMessageText ? `${statusMessageText}\n${trimmed}` : trimmed;
    if (candidate.length <= STATUS_MESSAGE_LIMIT) {
      await editStatusMessage(candidate);
      statusMessageText = candidate;
    } else {
      await sendNewStatusMessage(trimmed, entry.silent);
    }
  }

  function queueEvent(event: AgentEvent): void {
    eventQueue = eventQueue
      .then(async () => {
        if (statusUpdatesClosed || !interruptManager.hasActiveRequest(userId)) {
          return;
        }

        const entry = formatStatusEntry(event);
        if (!entry) {
          return;
        }
        await appendStatusEntry(entry);
      })
      .catch((error) => {
        logWarning('[CodexAdapter] Status update chain error', error);
      });
  }

  async function finalizeStatusUpdates(finalEntry?: string): Promise<void> {
    statusUpdatesClosed = true;
    if (finalEntry) {
      eventQueue = eventQueue
        .then(() => appendStatusEntry({ text: finalEntry, silent: false }))
        .catch((error) => {
          logWarning('[CodexAdapter] Final status update error', error);
        });
    }
    try {
      await eventQueue;
    } catch (error) {
      logWarning('[CodexAdapter] Status update flush failed', error);
    }
  }
  
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  let urlData: Awaited<ReturnType<typeof processUrls>> | null = null;
  let unsubscribe: (() => void) | null = null;

  try {
    // 处理 URL（如果消息中有链接）
    if (!imageFileIds && !documentFileId && text) {
      try {
        urlData = await processUrls(text, signal);
        if (urlData.imagePaths.length > 0 || urlData.filePaths.length > 0) {
          await ctx.reply(`🔗 检测到链接，正在下载...\n图片: ${urlData.imagePaths.length}\n文件: ${urlData.filePaths.length}`);
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw error;
        }
        logWarning('[CodexAdapter] URL processing failed', error);
      }
    }
    
    // 下载图片
    if (imageFileIds && imageFileIds.length > 0) {
      try {
        for (let i = 0; i < imageFileIds.length; i++) {
          const path = await downloadTelegramImage(
            ctx.api,
            imageFileIds[i],
            `image-${i}.jpg`,
            signal
          );
          imagePaths.push(path);
        }
      } catch (error) {
        cleanupImages(imagePaths);
        if ((error as Error).name === 'AbortError') {
          throw error;
        }
        throw new Error(`图片下载失败: ${(error as Error).message}`);
      }
    }
    
    // 添加 URL 下载的图片
    if (urlData) {
      imagePaths.push(...urlData.imagePaths);
    }
    
    // 下载文档文件
    if (documentFileId) {
      try {
        const doc = ctx.message?.document;
        const fileName = doc?.file_name || 'file.bin';
        const path = await downloadTelegramFile(ctx.api, documentFileId, fileName, signal);
        filePaths.push(path);
        await ctx.reply(`📥 已接收文件: ${fileName}\n正在处理...`);
      } catch (error) {
        cleanupImages(imagePaths);
        if ((error as Error).name === 'AbortError') {
          throw error;
        }
        throw new Error(`文件下载失败: ${(error as Error).message}`);
      }
    }
    
    // 添加 URL 下载的文件
    if (urlData) {
      filePaths.push(...urlData.filePaths);
    }

    // 监听事件
    unsubscribe = session.onEvent((event: AgentEvent) => {
      if (!interruptManager.hasActiveRequest(userId)) {
        return;
      }
      // 记录事件
      if (logger) {
        logger.logEvent(event);
      }
      queueEvent(event);
    });

    // 构建输入
    let input: Input;
    let enhancedText = urlData ? urlData.processedText : text;

    // 如果有文件，添加文件信息到提示
    if (filePaths.length > 0) {
      enhancedText += '\n\n用户上传的文件:';
      for (const path of filePaths) {
        const fileName = path.split('/').pop() || path;
        enhancedText += `\n- ${fileName}: ${path}`;
      }
    }

    enhancedText = injectDelegationGuide(enhancedText, session, agentMode);

    if (imagePaths.length > 0) {
      input = [
        { type: 'text', text: enhancedText },
        ...imagePaths.map((path) => ({ type: 'local_image' as const, path })),
      ];
    } else {
      input = enhancedText;
    }

    // 准备用户输入日志（可能现在还没有 logger）
    let userInputLog = enhancedText;
    if (imagePaths.length > 0) {
      userInputLog += `\n[附带 ${imagePaths.length} 张图片]`;
    }

    // 如果已有 logger，立即记录
    if (logger) {
      logger.logInput(userInputLog);
    }

    const result = await session.send(input, { streaming: true, signal });
    const delegation = await resolveDelegations(result, session, agentMode, {
      onInvoke: (prompt) => logger?.logOutput(`[Auto] 调用 Claude：${truncateForStatus(prompt)}`),
      onResult: (summary) => logger?.logOutput(`[Auto] Claude 完成：${truncateForStatus(summary.prompt)}`),
    });

    await finalizeStatusUpdates();
    unsubscribe?.();
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);
    interruptManager.complete(userId);

    saveThreadIdIfNeeded();

    // 确保 logger 存在（如果是新 thread，现在才有 threadId）
    const wasLoggerCreated = !logger;
    if (!logger) {
      logger = sessionManager.ensureLogger(userId);
    }

    // 如果 logger 是刚创建的，补充记录用户输入
    if (logger && wasLoggerCreated) {
      logger.logInput(userInputLog);
    }

    // 记录 AI 回复（不含 token 统计）
    if (logger) {
      logger.logOutput(result.response);
    }

    // 发送最终响应
    let finalText = delegation.response;
    let tokenUsageLine: string | null = null;
    
    const usage = delegation.usage ?? result.usage;
    if (usage) {
      const inputTokens = usage.input_tokens ?? 0;
      const cachedTokens = usage.cached_input_tokens ?? 0;
      const activeTokens = Math.max(inputTokens - cachedTokens, 0);
      const outputTokens = usage.output_tokens ?? 0;
      const totalTokens = inputTokens + outputTokens;
      const formatTokens = (value: number): string => {
        if (!value) {
          return "0k";
        }
        const absValue = Math.abs(value);
        if (absValue >= 1_000_000) {
          const mValue = value / 1_000_000;
          const precision = Math.abs(mValue) >= 10 ? 0 : 1;
          const formattedM = mValue.toFixed(precision).replace(/\.0$/, "");
          return `${formattedM}M`;
        }
        const kValue = value / 1000;
        const precision = Math.abs(kValue) >= 10 ? 0 : 1;
        const formattedK = kValue.toFixed(precision).replace(/\.0$/, "");
        return `${formattedK}k`;
      };
      const cachePercent = inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0;
      const tokenLine = [
        `Tokens · Input: ${formatTokens(inputTokens)}`,
        `Active: ${formatTokens(activeTokens)}`,
        `Cache Hit: ${cachePercent.toFixed(1)}%`,
        `Output: ${formatTokens(outputTokens)}`,
        `Total: ${formatTokens(totalTokens)}`,
      ].join(" | ");

      tokenUsageLine = tokenLine;
    }
    
    const chunks = chunkMessage(finalText);
    if (chunks.length === 0) {
      chunks.push('');
    }

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      let chunkText = chunks[i];
      if (i === chunks.length - 1 && tokenUsageLine) {
        const tokenBlock = formatCodeBlock(tokenUsageLine);
        chunkText = chunkText ? `${chunkText}\n\n${tokenBlock}` : tokenBlock;
      }
      await ctx.reply(chunkText, { parse_mode: 'Markdown' }).catch(async () => {
        await ctx.reply(chunkText);
      });
    }
  } catch (error) {
    if (unsubscribe) {
      unsubscribe();
    }
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);

    const errorMsg = error instanceof Error ? error.message : String(error);
    const isInterrupt = (error as Error).name === 'AbortError';
    const corruptedThread = shouldResetThread(error);
    const encryptedErrorDetails =
      error instanceof CodexThreadCorruptedError
        ? error.originalMessage ??
          (error.cause instanceof Error ? error.cause.message : undefined)
        : undefined;
    const corruptedDetail = encryptedErrorDetails ?? errorMsg;
    const replyText = isInterrupt
      ? '⛔️ 已中断执行'
      : corruptedThread
        ? `⚠️ ${CODEX_THREAD_RESET_HINT}\n\n${formatCodeBlock(corruptedDetail)}`
        : `❌ 错误: ${errorMsg}`;

    // 记录错误
    if (logger && !isInterrupt) {
      logger.logError(errorMsg);
    }

    if (corruptedThread) {
      logWarning('[CodexAdapter] Detected corrupted Codex thread, resetting session', error);
      sessionManager.reset(userId);
      logger = undefined;
    }

    await finalizeStatusUpdates(replyText);
    interruptManager.complete(userId);
    await ctx.reply(replyText);
  }
}

/**
 * 发送文件给用户
 */
export async function sendFileToUser(
  ctx: Context,
  filePath: string,
  caption?: string
): Promise<void> {
  try {
    await uploadFileToTelegram(ctx.api, ctx.chat!.id, filePath, caption);
  } catch (error) {
    throw new Error(`发送文件失败: ${(error as Error).message}`);
  }
}

export function interruptExecution(userId: number): boolean {
  return interruptManager.interrupt(userId);
}

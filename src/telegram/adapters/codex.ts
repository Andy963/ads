import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Context } from 'grammy';
import type { Input } from '../../agents/protocol/types.js';
import type { SessionManager } from '../utils/sessionManager.js';
import type { AgentEvent } from '../../codex/events.js';
import { downloadTelegramImage, cleanupImages } from '../utils/imageHandler.js';
import { downloadTelegramFile, cleanupFiles, uploadFileToTelegram } from '../utils/fileHandler.js';
import { processUrls } from '../utils/urlHandler.js';
import { InterruptManager } from '../utils/interruptManager.js';
import { escapeTelegramMarkdownV2 } from '../../utils/markdown.js';
import { appendMarkNoteEntry } from '../utils/noteLogger.js';
import { stripLeadingTranslation } from '../../utils/assistantText.js';
import { processAdrBlocks } from '../../utils/adrRecording.js';
import { detectWorkspaceFrom } from '../../workspace/detector.js';
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from '../../workspace/adsPaths.js';
import {
  CODEX_THREAD_RESET_HINT,
  CodexThreadCorruptedError,
  shouldResetThread,
} from '../../codex/errors.js';
import { createLogger } from '../../utils/logger.js';
import { createTelegramCodexStatusUpdater } from './codex/statusUpdater.js';
import { chunkMessage } from './codex/chunkMessage.js';
// 全局中断管理器
const interruptManager = new InterruptManager();
const adapterLogger = createLogger('TelegramCodexAdapter');
export async function handleCodexMessage(
  ctx: Context,
  text: string,
  sessionManager: SessionManager,
  streamUpdateIntervalMs: number,
  imageFileIds?: string[],
  documentFileId?: string,
  cwd?: string,
  options?: { markNoteEnabled?: boolean; silentNotifications?: boolean }
) {
  const workspaceRoot = cwd ? path.resolve(cwd) : process.cwd();
  migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot);
  const adapterLogDir = resolveWorkspaceStatePath(workspaceRoot, 'logs');
  const adapterLogFile = path.join(adapterLogDir, 'telegram-bot.log');
  const fallbackLogFile = path.join(adapterLogDir, 'telegram-fallback.log');
  const markNoteEnabled = options?.markNoteEnabled ?? false;
  const silentNotifications = options?.silentNotifications ?? true;
  let logDirReady = false;

  const ensureLogDir = () => {
    if (!logDirReady) {
      fs.mkdirSync(adapterLogDir, { recursive: true });
      logDirReady = true;
    }
  };

  const fallbackLogFullEnabled = (() => {
    const raw = process.env.ADS_TELEGRAM_FALLBACK_LOG_FULL;
    if (!raw) {
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  })();
  const FALLBACK_PREVIEW_CHARS = 200;

  const ensurePrivateFile = (filePath: string): void => {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore
    }
  };

  const appendPrivateLog = (filePath: string, content: string): void => {
    fs.appendFileSync(filePath, content, { mode: 0o600 });
    ensurePrivateFile(filePath);
  };

  const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

  const truncateSingleLine = (value: string, maxChars: number): string => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
  };

  const logWarning = (message: string, error?: unknown) => {
    const timestamp = new Date().toISOString();
    const detail = error
      ? error instanceof Error
        ? error.stack ?? error.message
        : String(error)
      : '';
    try {
      ensureLogDir();
      appendPrivateLog(adapterLogFile, `${timestamp} WARN ${message}${detail ? ` | ${detail}` : ''}\n`);
    } catch (fileError) {
      adapterLogger.warn('Failed to write adapter log', fileError);
    }
    adapterLogger.warn(message, error);
  };

  const recordFallback = (stage: string, original: string, escapedV2: string) => {
    try {
      ensureLogDir();
      const timestamp = new Date().toISOString();
      const entry = fallbackLogFullEnabled
        ? `${timestamp} ${stage}\nORIGINAL:\n${original}\n---\nMARKDOWN_V2:\n${escapedV2}\n\n`
        : `${timestamp} ${stage} original_len=${original.length} original_sha256=${sha256Hex(original)} markdown_len=${escapedV2.length} markdown_sha256=${sha256Hex(escapedV2)} original_preview=${JSON.stringify(truncateSingleLine(original, FALLBACK_PREVIEW_CHARS))}\n`;
      appendPrivateLog(fallbackLogFile, entry);
    } catch (fileError) {
      adapterLogger.warn('Failed to record fallback', fileError);
    }
  };

  const rawUserId = ctx.from?.id;
  if (typeof rawUserId !== 'number') {
    logWarning('[Telegram] Missing user id (ctx.from.id) in update');
    if (ctx.chat) {
      try {
        await ctx.reply('❌ 无法识别用户信息（可能是匿名/频道消息），请用普通用户身份发送消息后重试。', {
          disable_notification: silentNotifications,
        });
      } catch (error) {
        logWarning('[Telegram] Failed to reply about missing user id', error);
      }
    }
    return;
  }

  const userId = rawUserId;

  const rawChatId = ctx.chat?.id;
  if (typeof rawChatId !== 'number') {
    logWarning('[Telegram] Missing chat id (ctx.chat.id) in update');
    return;
  }
  const chatId = rawChatId;

  // 检查是否有活跃请求
  if (interruptManager.hasActiveRequest(userId)) {
    await ctx.reply('⚠️ 已有请求正在执行，请等待完成或使用 /esc 中断', {
      disable_notification: silentNotifications,
    });
    return;
  }

  const session = sessionManager.getOrCreate(userId, cwd);
  const activeAgentLabel = 'Codex';

  const saveThreadIdIfNeeded = () => {
    // No-op in simplified version
  };

  // 注册请求
  const signal = interruptManager.registerRequest(userId).signal;

  const statusUpdater = await createTelegramCodexStatusUpdater({
    ctx,
    chatId,
    activeAgentLabel,
    silentNotifications,
    streamUpdateIntervalMs,
    isActiveRequest: () => interruptManager.hasActiveRequest(userId),
    logWarning,
  });

  function formatCodeBlock(text: string): string {
    const safe = text.replace(/```/g, '`​``');
    return ['```', safe || '\u200b', '```'].join('\n');
  }

  function formatAttachmentList(paths: string[]): string {
    if (!paths.length) {
      return '';
    }
    const names = paths.map((p) => {
      const basename = path.basename(p);
      const rel = path.relative(workspaceRoot, p);
      if (!rel || rel.startsWith('..')) {
        return basename;
      }
      return rel;
    });
    return names.join(', ');
  }

function buildUserLogEntry(rawText: string | undefined, images: string[], files: string[]): string {
  const lines: string[] = [];
  const trimmed = rawText?.trim();
  lines.push(trimmed ? trimmed : '(no text)');
  if (images.length) {
    lines.push(`Images: ${formatAttachmentList(images)}`);
  }
  if (files.length) {
    lines.push(`Files: ${formatAttachmentList(files)}`);
  }
  return lines.join('\n');
}

  function queueEvent(event: AgentEvent): void {
    statusUpdater.queueEvent(event);
  }

  // queueStatusLine removed in simplified version (no collaborative turns)

  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  let urlData: Awaited<ReturnType<typeof processUrls>> | null = null;
  let unsubscribe: (() => void) | null = null;
  let userLogEntry: string | null = null;

  try {
    statusUpdater.startTyping();
    // 处理 URL（如果消息中有链接）
    if (!imageFileIds && !documentFileId && text) {
      try {
        urlData = await processUrls(text, signal);
        if (urlData.imagePaths.length > 0 || urlData.filePaths.length > 0) {
          await ctx.reply(
            `🔗 检测到链接，正在下载...\n图片: ${urlData.imagePaths.length}\n文件: ${urlData.filePaths.length}`,
            { disable_notification: silentNotifications },
          );
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
        await ctx.reply(`📥 已接收文件: ${fileName}\n正在处理...`, {
          disable_notification: silentNotifications,
        });
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

    // 记录用户输入
    userLogEntry = buildUserLogEntry(text, imagePaths, filePaths);

    // 监听事件
    unsubscribe = session.onEvent((event: AgentEvent) => {
      if (!interruptManager.hasActiveRequest(userId)) {
        return;
      }
      queueEvent(event);
    });

    // 构建输入
    let input: Input;
    let enhancedText = urlData ? urlData.processedText : text;
    const attachFiles = false;

    // 如果有文件，添加文件信息到提示
    if (filePaths.length > 0) {
      enhancedText += '\n\n用户上传的文件:';
      for (const path of filePaths) {
        const fileName = path.split('/').pop() || path;
        enhancedText += `\n- ${fileName}: ${path}`;
      }
    }

    const inputParts: Array<{ type: string; text?: string; path?: string }> = [];
    if (enhancedText.trim()) {
      inputParts.push({ type: 'text', text: enhancedText });
    }
    if (imagePaths.length > 0) {
      inputParts.push(...imagePaths.map((path) => ({ type: 'local_image', path })));
    }
    if (attachFiles && filePaths.length > 0) {
      inputParts.push(...filePaths.map((path) => ({ type: 'local_file', path })));
    }

    if (inputParts.length === 1 && inputParts[0].type === 'text') {
      input = inputParts[0].text ?? '';
    } else {
      input = inputParts as Input;
    }

    // Direct session.send() call instead of runCollaborativeTurn
    const result = await session.send(input, {
      streaming: true,
      signal,
    });

    await statusUpdater.finalize();
    statusUpdater.stopTyping();
    unsubscribe?.();
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);
    interruptManager.complete(userId);

    saveThreadIdIfNeeded();

    const baseOutput =
      typeof result.response === 'string'
        ? result.response
        : String(result.response ?? '');
    const cleanedOutput = stripLeadingTranslation(baseOutput);
    const workspaceRootForAdr = detectWorkspaceFrom(workspaceRoot);
    let outputToSend = cleanedOutput;
    try {
      const adrProcessed = processAdrBlocks(cleanedOutput, workspaceRootForAdr);
      outputToSend = adrProcessed.finalText || cleanedOutput;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`[ADR] Failed to record ADR: ${message}`, error);
      outputToSend = `${cleanedOutput}\n\n---\nADR warning: failed to record ADR (${message})`;
    }

    if (markNoteEnabled && userLogEntry) {
      try {
        appendMarkNoteEntry(workspaceRoot, userLogEntry, outputToSend);
      } catch (error) {
        logWarning('[CodexAdapter] Failed to append mark note', error);
      }
    }

    // 发送最终响应
    const renderText = outputToSend;
    let fallbackNotified = false;
    const notifyFallback = async () => {
      if (fallbackNotified) return;
      fallbackNotified = true;
      await ctx.reply('⚠️ 本条消息的 Markdown 渲染发生降级，内容已记录便于排查。', {
        disable_notification: silentNotifications,
      }).catch((error) => {
        logWarning('[Telegram] Failed to send markdown fallback notice', error);
      });
    };
    
    const chunks = chunkMessage(renderText);
    if (chunks.length === 0) {
      chunks.push('');
    }

    const sentChunks = new Set<string>();
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const chunkText = chunks[i];
      if (sentChunks.has(chunkText)) {
        continue;
      }
      const escapedV2 = escapeTelegramMarkdownV2(chunkText);
      await ctx.reply(escapedV2, {
        parse_mode: 'MarkdownV2',
        disable_notification: silentNotifications,
      }).catch(async (error) => {
        recordFallback('chunk_markdownv2_failed', chunkText, escapedV2);
        if (!fallbackNotified) {
          logWarning('[Telegram] Failed to send MarkdownV2 chunk; falling back to plain text', error);
        }
        await notifyFallback();
        await ctx.reply(chunkText, { disable_notification: silentNotifications }).catch((error) => {
          logWarning('[Telegram] Failed to send fallback chunk', error);
        });
      });
      sentChunks.add(chunkText);
    }

    statusUpdater.stopTyping();
  } catch (error) {
    statusUpdater.stopTyping();
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
      ? '⛔️ 已中断当前任务'
      : corruptedThread
        ? `⚠️ ${CODEX_THREAD_RESET_HINT}\n\n${formatCodeBlock(corruptedDetail)}`
        : `❌ 错误: ${errorMsg}`;

    if (corruptedThread) {
      logWarning('[CodexAdapter] Detected corrupted Codex thread, resetting session', error);
      sessionManager.reset(userId);
    }

    await statusUpdater.finalize(replyText);
    interruptManager.complete(userId);
    const escapedV2 = escapeTelegramMarkdownV2(replyText);
    await ctx.reply(escapedV2, {
      parse_mode: 'MarkdownV2',
      disable_notification: silentNotifications,
    }).catch(async (error) => {
      recordFallback('error_markdownv2_failed', replyText, escapedV2);
      logWarning('[Telegram] Failed to send MarkdownV2 error message; falling back to plain text', error);
      await ctx.reply(replyText, { disable_notification: silentNotifications }).catch((error) => {
        logWarning('[Telegram] Failed to send fallback error message', error);
      });
    });
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
  const chatId = ctx.chat?.id;
  if (typeof chatId !== 'number') {
    throw new Error('发送文件失败: 无法识别 chat.id');
  }
  try {
    await uploadFileToTelegram(ctx.api, chatId, filePath, caption);
  } catch (error) {
    throw new Error(`发送文件失败: ${(error as Error).message}`);
  }
}

export function interruptExecution(userId: number): boolean {
  return interruptManager.interrupt(userId);
}

import { GrammyError, type Context } from 'grammy';
import type { SessionManager } from '../utils/sessionManager.js';
import type { AgentEvent } from '../../codex/events.js';
import { downloadTelegramImage, cleanupImages } from '../utils/imageHandler.js';
import { downloadTelegramFile, cleanupFiles, uploadFileToTelegram } from '../utils/fileHandler.js';
import { processUrls } from '../utils/urlHandler.js';
import { InterruptManager } from '../utils/interruptManager.js';

// 全局中断管理器
const interruptManager = new InterruptManager();

function chunkMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let current = '';
  const lines = text.split('\n');
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    if (current.length + line.length + 1 > maxLen) {
      if (inCodeBlock && current) {
        current += '\n```';
        inCodeBlock = false;
      }
      
      if (current) {
        chunks.push(current.trim());
      }
      
      if (inCodeBlock) {
        current = '```\n' + line;
      } else {
        current = line;
      }
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current) {
    if (inCodeBlock) {
      current += '\n```';
    }
    chunks.push(current.trim());
  }

  return chunks;
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
  
  // 检查是否有活跃请求
  if (interruptManager.hasActiveRequest(userId)) {
    await ctx.reply('⚠️ 已有请求正在执行，请等待完成或使用 /stop 中断');
    return;
  }
  
  const session = sessionManager.getOrCreate(userId, cwd);
  
  const saveThreadIdIfNeeded = () => {
    const threadId = session.getThreadId();
    if (threadId) {
      sessionManager.saveThreadId(userId, threadId);
    }
  };

  // 注册请求
  const signal = interruptManager.registerRequest(userId).signal;

  const STATUS_MESSAGE_LIMIT = 3600; // Telegram 限 4096，预留安全空间
  const COMMAND_OUTPUT_LIMIT = 800;
  const sentMsg = await ctx.reply('💭 开始处理...');
  let statusMessageId = sentMsg.message_id;
  let statusMessageText = sentMsg.text ?? '💭 开始处理...';
  let statusUpdatesClosed = false;
  let rateLimitUntil = 0;
  let statusUpdateChain: Promise<void> = Promise.resolve();

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
      .map((line) => `  ${line}`)
      .join('\n');
  }

  function formatCommandOutput(event: AgentEvent): string | null {
    const rawItem = (event.raw as any)?.item;
    if (!rawItem || rawItem.type !== 'command_execution') {
      return null;
    }
    const output: string | undefined = rawItem.aggregated_output;
    if (!output) {
      return null;
    }
    const trimmed = output.trim();
    if (!trimmed) {
      return null;
    }
    const limited =
      trimmed.length > COMMAND_OUTPUT_LIMIT
        ? `${trimmed.slice(0, COMMAND_OUTPUT_LIMIT - 1)}…`
        : trimmed;
    return indent(limited);
  }

  function formatStatusEntry(event: AgentEvent): string | null {
    const icon = PHASE_ICON[event.phase] ?? '💬';
    const title = event.title || PHASE_FALLBACK[event.phase] || '处理中';
    const lines: string[] = [`${icon} ${title}`];

    if (event.detail) {
      const detail = event.detail.length > 500 ? `${event.detail.slice(0, 497)}...` : event.detail;
      lines.push(indent(detail));
    }

    const commandOutput = formatCommandOutput(event);
    if (commandOutput) {
      lines.push(commandOutput);
    }

    return lines.join('\n');
  }

  async function editStatusMessage(text: string): Promise<void> {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      await ctx.api.editMessageText(ctx.chat!.id, statusMessageId, text);
      rateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 400 && error.description?.includes('message is not modified')) {
        return;
      }
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        console.warn(`[Telegram] Status update rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await editStatusMessage(text);
      } else {
        console.warn('[CodexAdapter] Failed to edit status message:', error);
      }
    }
  }

  async function sendNewStatusMessage(initialText: string): Promise<void> {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      const newMsg = await ctx.reply(initialText);
      statusMessageId = newMsg.message_id;
      statusMessageText = initialText;
      rateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        console.warn(`[Telegram] Sending status rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await sendNewStatusMessage(initialText);
      } else {
        console.warn('[CodexAdapter] Failed to send status message:', error);
      }
    }
  }

  async function appendStatusEntry(entry: string): Promise<void> {
    if (!entry) {
      return;
    }
    const trimmed = entry.trimEnd();
    const candidate = statusMessageText ? `${statusMessageText}\n${trimmed}` : trimmed;
    if (candidate.length <= STATUS_MESSAGE_LIMIT) {
      await editStatusMessage(candidate);
      statusMessageText = candidate;
    } else {
      await sendNewStatusMessage(trimmed);
    }
  }

  function queueStatusUpdate(event: AgentEvent): void {
    statusUpdateChain = statusUpdateChain
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
        console.warn('[CodexAdapter] Status update chain error:', error);
      });
  }

  async function finalizeStatusUpdates(finalEntry?: string): Promise<void> {
    if (finalEntry) {
      statusUpdateChain = statusUpdateChain
        .then(() => appendStatusEntry(finalEntry))
        .catch((error) => {
          console.warn('[CodexAdapter] Final status update error:', error);
        });
    }
    statusUpdatesClosed = true;
    try {
      await statusUpdateChain;
    } catch (error) {
      console.warn('[CodexAdapter] Status update flush failed:', error);
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
        console.warn('[CodexAdapter] URL processing failed:', error);
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
      queueStatusUpdate(event);
    });

    // 构建输入
    let input: any;
    let enhancedText = urlData ? urlData.processedText : text;
    
    // 如果有文件，添加文件信息到提示
    if (filePaths.length > 0) {
      enhancedText += '\n\n用户上传的文件:';
      for (const path of filePaths) {
        const fileName = path.split('/').pop() || path;
        enhancedText += `\n- ${fileName}: ${path}`;
      }
    }
    
    if (imagePaths.length > 0) {
      input = [
        { type: 'text', text: enhancedText },
        ...imagePaths.map(path => ({ type: 'local_image', path }))
      ];
    } else {
      input = enhancedText;
    }

    const result = await session.send(input, { streaming: true, signal });

    await finalizeStatusUpdates();
    unsubscribe?.();
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);
    interruptManager.complete(userId);
    
    saveThreadIdIfNeeded();

    // 发送最终响应
    let finalText = result.response;
    
    if (result.usage) {
      const stats = [
        `\n\n📊 Token 使用:`,
        `• 输入: ${result.usage.input_tokens}`,
      ];
      
      if (result.usage.cached_input_tokens > 0) {
        stats.push(`• 缓存: ${result.usage.cached_input_tokens}`);
      }
      
      stats.push(`• 输出: ${result.usage.output_tokens}`);
      stats.push(`• 总计: ${result.usage.input_tokens + result.usage.output_tokens}`);
      
      finalText += stats.join(' ');
    }
    
    const chunks = chunkMessage(finalText);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await ctx.reply(chunks[i], { parse_mode: 'Markdown' }).catch(async () => {
        await ctx.reply(chunks[i]);
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
    const replyText = isInterrupt ? '⛔️ 已中断执行' : `❌ 错误: ${errorMsg}`;
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

import type { Context } from 'grammy';
import type { SessionManager } from '../utils/sessionManager.js';
import type { AgentEvent } from '../../codex/events.js';
import { downloadTelegramImage, cleanupImages } from '../utils/imageHandler.js';
import { downloadTelegramFile, cleanupFile, cleanupFiles, uploadFileToTelegram } from '../utils/fileHandler.js';
import { processUrls } from '../utils/urlHandler.js';
import { formatThreadEvent } from '../utils/eventFormatter.js';
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
  streamUpdateIntervalMs: number,
  imageFileIds?: string[],
  documentFileId?: string
) {
  const userId = ctx.from!.id;
  
  // 检查是否有活跃请求
  if (interruptManager.hasActiveRequest(userId)) {
    await ctx.reply('⚠️ 已有请求正在执行，请等待完成或使用 /stop 中断');
    return;
  }
  
  const session = sessionManager.getOrCreate(userId);
  
  const saveThreadIdIfNeeded = () => {
    const threadId = session.getThreadId();
    if (threadId) {
      sessionManager.saveThreadId(userId, threadId);
    }
  };

  // 注册请求
  interruptManager.registerRequest(userId);

  const sentMsg = await ctx.reply('💭 开始处理...', { parse_mode: 'Markdown' });
  const eventMessages: string[] = [];
  let lastUpdate = Date.now();
  
  // 处理 URL（如果消息中有链接）
  let urlData: Awaited<ReturnType<typeof processUrls>> | null = null;
  if (!imageFileIds && !documentFileId && text) {
    try {
      urlData = await processUrls(text);
      if (urlData.imagePaths.length > 0 || urlData.filePaths.length > 0) {
        await ctx.reply(`🔗 检测到链接，正在下载...\n图片: ${urlData.imagePaths.length}\n文件: ${urlData.filePaths.length}`);
      }
    } catch (error) {
      console.warn('[CodexAdapter] URL processing failed:', error);
    }
  }
  
  // 下载图片
  const imagePaths: string[] = [];
  if (imageFileIds && imageFileIds.length > 0) {
    try {
      for (let i = 0; i < imageFileIds.length; i++) {
        const path = await downloadTelegramImage(
          ctx.api,
          imageFileIds[i],
          `image-${i}.jpg`
        );
        imagePaths.push(path);
      }
    } catch (error) {
      cleanupImages(imagePaths);
      interruptManager.complete(userId);
      throw new Error(`图片下载失败: ${(error as Error).message}`);
    }
  }
  
  // 添加 URL 下载的图片
  if (urlData) {
    imagePaths.push(...urlData.imagePaths);
  }
  
  // 下载文档文件
  const filePaths: string[] = [];
  if (documentFileId) {
    try {
      const doc = ctx.message?.document;
      const fileName = doc?.file_name || 'file.bin';
      const path = await downloadTelegramFile(ctx.api, documentFileId, fileName);
      filePaths.push(path);
      await ctx.reply(`📥 已接收文件: ${fileName}\n正在处理...`);
    } catch (error) {
      cleanupImages(imagePaths);
      interruptManager.complete(userId);
      throw new Error(`文件下载失败: ${(error as Error).message}`);
    }
  }
  
  // 添加 URL 下载的文件
  if (urlData) {
    filePaths.push(...urlData.filePaths);
  }

  // 监听事件
  const unsubscribe = session.onEvent((event: AgentEvent) => {
    // 检查中断
    if (!interruptManager.hasActiveRequest(userId)) {
      return;
    }

    const now = Date.now();
    if (now - lastUpdate < streamUpdateIntervalMs) {
      return;
    }

    lastUpdate = now;
    
    // 简化事件展示 - 使用纯文本避免 Markdown 解析问题
    let status = '💭 处理中...';
    
    if (event.title) {
      // 限制长度，防止超长文本
      const shortTitle = event.title.length > 100 ? event.title.slice(0, 97) + '...' : event.title;
      
      if (event.phase === 'command') {
        status = `⚙️ 执行: ${shortTitle}`;
      } else if (event.phase === 'editing') {
        status = `✏️ 编辑: ${shortTitle}`;
      } else if (event.phase === 'tool') {
        status = `🔧 工具: ${shortTitle}`;
      }
    } else {
      if (event.phase === 'command') status = '⚙️ 执行命令...';
      else if (event.phase === 'editing') status = '✏️ 编辑文件...';
      else if (event.phase === 'tool') status = '🔧 调用工具...';
    }

    // 使用纯文本，避免 Markdown 解析问题
    ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, status)
      .catch(() => {});
  });

  try {
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

    const signal = interruptManager.getSignal(userId);
    const result = await session.send(input, { streaming: true, signal });

    unsubscribe();
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

    if (chunks.length === 1) {
      await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, chunks[0], { 
        parse_mode: 'Markdown' 
      }).catch(async () => {
        await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, chunks[0]);
      });
    } else {
      await ctx.api.deleteMessage(ctx.chat!.id, sentMsg.message_id);
      
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        await ctx.reply(chunks[i], { parse_mode: 'Markdown' }).catch(async () => {
          await ctx.reply(chunks[i]);
        });
      }
    }
  } catch (error) {
    unsubscribe();
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);
    interruptManager.complete(userId);
    
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isInterrupt = !interruptManager.hasActiveRequest(userId);
    
    await ctx.api.editMessageText(
      ctx.chat!.id,
      sentMsg.message_id,
      isInterrupt ? `⛔️ 已中断执行` : `❌ 错误: ${errorMsg}`
    ).catch(() => {
      ctx.reply(isInterrupt ? `⛔️ 已中断执行` : `❌ 错误: ${errorMsg}`);
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
  try {
    await uploadFileToTelegram(ctx.api, ctx.chat!.id, filePath, caption);
  } catch (error) {
    throw new Error(`发送文件失败: ${(error as Error).message}`);
  }
}

export function interruptExecution(userId: number): boolean {
  return interruptManager.interrupt(userId);
}

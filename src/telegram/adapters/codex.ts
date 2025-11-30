import fs from 'node:fs';
import path from 'node:path';

import { GrammyError, type Context } from 'grammy';
import type {
  Input,
  CommandExecutionItem,
  TodoListItem,
  ThreadEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
} from '@openai/codex-sdk';
import type { SessionManager } from '../utils/sessionManager.js';
import type { AgentEvent } from '../../codex/events.js';
import { downloadTelegramImage, cleanupImages } from '../utils/imageHandler.js';
import { downloadTelegramFile, cleanupFiles, uploadFileToTelegram } from '../utils/fileHandler.js';
import { processUrls } from '../utils/urlHandler.js';
import { InterruptManager } from '../utils/interruptManager.js';
import { escapeTelegramMarkdown, escapeTelegramMarkdownV2 } from '../../utils/markdown.js';
import { injectDelegationGuide, resolveDelegations } from '../../agents/delegation.js';
import { appendMarkNoteEntry } from '../utils/noteLogger.js';
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
  cwd?: string,
  options?: { markNoteEnabled?: boolean; silentNotifications?: boolean }
) {
  const userId = ctx.from!.id;
  const workspaceRoot = cwd ? path.resolve(cwd) : process.cwd();
  const adapterLogDir = path.join(workspaceRoot, '.ads', 'logs');
  const adapterLogFile = path.join(adapterLogDir, 'telegram-bot.log');
  const markNoteEnabled = options?.markNoteEnabled ?? false;
  const silentNotifications = options?.silentNotifications ?? true;
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
    await ctx.reply('⚠️ 已有请求正在执行，请等待完成或使用 /esc 中断', {
      disable_notification: silentNotifications,
    });
    return;
  }

  const session = sessionManager.getOrCreate(userId, cwd);
  const activeAgentLabel = sessionManager.getActiveAgentLabel(userId) || 'Codex';

  const saveThreadIdIfNeeded = () => {
    const threadId = session.getThreadId();
    if (threadId) {
      sessionManager.saveThreadId(userId, threadId);
    }
  };

  // 尝试获取或创建 logger（如果 threadId 还没有，也会先写入日志）
  let logger = sessionManager.ensureLogger(userId);

  // 注册请求
  const signal = interruptManager.registerRequest(userId).signal;

  const STATUS_MESSAGE_LIMIT = 3600; // Telegram 限 4096，预留安全空间
  const COMMAND_TEXT_MAX_LINES = 5;
  const COMMAND_OUTPUT_MAX_LINES = 10;
  const COMMAND_OUTPUT_MAX_CHARS = 1200;
  const sentMsg = await ctx.reply(`💭 [${activeAgentLabel}] 开始处理...`, {
    disable_notification: silentNotifications,
  });
  let statusMessageId = sentMsg.message_id;
  let statusMessageText = sentMsg.text ?? '💭 开始处理...';
  let statusUpdatesClosed = false;
  let rateLimitUntil = 0;
  let eventQueue: Promise<void> = Promise.resolve();
  let planMessageId: number | null = null;
  let lastPlanContent: string | null = null;
  let lastTodoSignature: string | null = null;
  let commandMessageId: number | null = null;
  let commandMessageText: string | null = null;
  let commandMessageRateLimitUntil = 0;

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

    const commandItem = getCommandExecutionItem(event.raw);
    if (commandItem) {
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

    return {
      text: lines.join('\n'),
      silent: silentNotifications,
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
        disable_notification: silent ?? silentNotifications,
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
      // 状态消息超长发了新消息，重新把 plan 固定到底部
      await resendPlanToBottom();
    }
  }

  function buildTodoListSignature(item: TodoListItem): string {
    const entries = item.items ?? [];
    return JSON.stringify(
      entries.map((entry) => ({
        text: entry.text ?? '',
        completed: !!entry.completed,
      })),
    );
  }

  type TodoListThreadEvent = (ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent) & {
    item: TodoListItem;
  };

  function isTodoListEvent(rawEvent: ThreadEvent): rawEvent is TodoListThreadEvent {
    if (
      rawEvent.type === 'item.started' ||
      rawEvent.type === 'item.updated' ||
      rawEvent.type === 'item.completed'
    ) {
      const item = (rawEvent as ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent).item;
      return item.type === 'todo_list';
    }
    return false;
  }

  function formatTodoListUpdate(event: TodoListThreadEvent): string | null {
    const entries = event.item.items ?? [];
    if (entries.length === 0) {
      return null;
    }
    const completed = entries.filter((entry) => entry.completed).length;
    const stageLabel =
      event.type === 'item.started'
        ? '生成任务计划'
        : event.type === 'item.completed'
          ? '任务计划完成'
          : '更新任务计划';

    const lines = entries.slice(0, 8).map((entry, index) => {
      const marker = entry.completed ? '✅' : '⬜️';
      const text = entry.text?.trim() || `步骤 ${index + 1}`;
      return `${marker} ${index + 1}. ${text}`;
    });
    const more = entries.length > 8 ? `... 还有 ${entries.length - 8} 项` : '';
    return [
      `📋 ${stageLabel} (${completed}/${entries.length})`,
      ...lines,
      more,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async function sendPlanMessage(text: string): Promise<void> {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      const msg = await ctx.reply(text, { disable_notification: silentNotifications });
      planMessageId = msg.message_id;
      lastPlanContent = text;
      rateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        logWarning(`[Telegram] Plan message rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await sendPlanMessage(text);
      } else {
        logWarning('[CodexAdapter] Failed to send plan update', error);
      }
    }
  }

  async function upsertPlanMessage(text: string): Promise<void> {
    lastPlanContent = text;
    if (!planMessageId) {
      await sendPlanMessage(text);
      return;
    }
    try {
      await ctx.api.editMessageText(ctx.chat!.id, planMessageId, text);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 400) {
        planMessageId = null;
        await sendPlanMessage(text);
      } else {
        logWarning('[CodexAdapter] Failed to update plan message', error);
      }
    }
  }

  async function deletePlanMessage(): Promise<void> {
    if (!planMessageId) {
      return;
    }
    try {
      await ctx.api.deleteMessage(ctx.chat!.id, planMessageId);
    } catch (error) {
      // 消息可能已被删除，忽略错误
      if (!(error instanceof GrammyError && error.error_code === 400)) {
        logWarning('[CodexAdapter] Failed to delete plan message', error);
      }
    }
    planMessageId = null;
  }

  async function resendPlanToBottom(): Promise<void> {
    if (!lastPlanContent) {
      return;
    }
    await deletePlanMessage();
    await sendPlanMessage(lastPlanContent);
  }

  async function maybeSendTodoListUpdate(event: AgentEvent): Promise<void> {
    const raw = event.raw;
    if (!isTodoListEvent(raw)) {
      return;
    }
    const signature = buildTodoListSignature(raw.item);
    if (signature === lastTodoSignature) {
      return;
    }
    lastTodoSignature = signature;
    const message = formatTodoListUpdate(raw);
    if (!message) {
      return;
    }
    await upsertPlanMessage(message);
  }

  async function maybeUpdateCommandLog(event: AgentEvent): Promise<void> {
    const commandItem = getCommandExecutionItem(event.raw);
    if (!commandItem) {
      return;
    }
    const message = buildCommandLogMessage(commandItem, event.detail);
    if (!message) {
      return;
    }
    await upsertCommandLogMessage(message);
  }

  function buildCommandLogMessage(rawItem: CommandExecutionItem, fallbackDetail?: string): string | null {
    const commandLine =
      (typeof rawItem.command === 'string' && rawItem.command.trim())
        ? rawItem.command.trim()
        : (fallbackDetail?.trim() ?? '');
    if (!commandLine) {
      return null;
    }
    const { text: truncatedCommand } = truncateCommandText(commandLine, COMMAND_TEXT_MAX_LINES);
    const statusLabel = buildCommandStatusLabel(rawItem);
    const sections: string[] = [
      `⚙️ 命令:\n${formatCodeBlock(truncatedCommand)}`,
    ];
    const outputSnippet = formatCommandOutput(rawItem.aggregated_output);
    if (outputSnippet) {
      sections.push(`输出:\n${formatCodeBlock(outputSnippet)}`);
    }
    sections.push(`状态：${statusLabel}`);
    return sections.join('\n\n');
  }

  function buildCommandStatusLabel(rawItem: CommandExecutionItem): string {
    const exitText = rawItem.exit_code === undefined ? '' : ` (exit ${rawItem.exit_code})`;
    if (rawItem.status === 'failed') {
      return `❌ 失败${exitText}`;
    }
    if (rawItem.status === 'completed') {
      return `✅ 已完成${exitText}`;
    }
    return `⏳ 执行中${exitText}`;
  }

  function formatCommandOutput(
    output?: string | null,
  ): string | null {
    if (!output) {
      return null;
    }
    const trimmed = output.trim();
    if (!trimmed) {
      return null;
    }
    const lines = trimmed.split(/\r?\n/);
    const keptLines = lines.slice(0, COMMAND_OUTPUT_MAX_LINES);
    let snippet = keptLines.join('\n');
    let truncated = lines.length > COMMAND_OUTPUT_MAX_LINES;
    if (snippet.length > COMMAND_OUTPUT_MAX_CHARS) {
      snippet = snippet.slice(0, COMMAND_OUTPUT_MAX_CHARS);
      truncated = true;
    }
    if (truncated) {
      snippet = `${snippet.trimEnd()}\n…`;
    }
    return snippet;
  }

  async function upsertCommandLogMessage(text: string): Promise<void> {
    if (commandMessageId) {
      if (commandMessageText === text) {
        return;
      }
      await editCommandLogMessage(text);
    } else {
      await sendCommandLogMessage(text);
    }
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

  async function sendCommandLogMessage(text: string): Promise<void> {
    const now = Date.now();
    if (now < commandMessageRateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, commandMessageRateLimitUntil - now));
    }
    try {
      const newMsg = await ctx.reply(text, {
        parse_mode: 'Markdown',
        disable_notification: silentNotifications,
      });
      commandMessageId = newMsg.message_id;
      commandMessageText = text;
      commandMessageRateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        commandMessageRateLimitUntil = Date.now() + retryAfter * 1000;
        logWarning(`[Telegram] Command log rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await sendCommandLogMessage(text);
      } else {
        logWarning('[CodexAdapter] Failed to send command log message', error);
      }
    }
  }

  async function editCommandLogMessage(text: string): Promise<void> {
    if (!commandMessageId) {
      await sendCommandLogMessage(text);
      return;
    }
    if (commandMessageText === text) {
      return;
    }
    const now = Date.now();
    if (now < commandMessageRateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, commandMessageRateLimitUntil - now));
    }
    try {
      await ctx.api.editMessageText(ctx.chat!.id, commandMessageId, text, {
        parse_mode: 'Markdown',
      });
      commandMessageText = text;
      commandMessageRateLimitUntil = 0;
    } catch (error) {
      if (error instanceof GrammyError) {
        if (error.error_code === 400 && error.description?.includes('message is not modified')) {
          return;
        }
        if (error.error_code === 400 && error.description?.includes('message to edit not found')) {
          commandMessageId = null;
          commandMessageText = null;
          await sendCommandLogMessage(text);
          return;
        }
        if (error.error_code === 429) {
          const retryAfter = error.parameters?.retry_after ?? 1;
          commandMessageRateLimitUntil = Date.now() + retryAfter * 1000;
          logWarning(`[Telegram] Command log edit rate limited, retry after ${retryAfter}s`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          await editCommandLogMessage(text);
          return;
        }
      }
      logWarning('[CodexAdapter] Failed to edit command log message', error);
    }
  }
  function queueEvent(event: AgentEvent): void {
    eventQueue = eventQueue
      .then(async () => {
        if (statusUpdatesClosed || !interruptManager.hasActiveRequest(userId)) {
          return;
        }

        await maybeSendTodoListUpdate(event);
        await maybeUpdateCommandLog(event);
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
        .then(() => appendStatusEntry({ text: finalEntry, silent: silentNotifications }))
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
  let userLogEntry: string | null = null;

  try {
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

    // 记录用户输入（使用原始文本 + 附件概览，不带系统注入）
    userLogEntry = buildUserLogEntry(text, imagePaths, filePaths);
    if (logger && userLogEntry) {
      logger.logInput(userLogEntry);
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

    enhancedText = injectDelegationGuide(enhancedText, session);

    if (imagePaths.length > 0) {
      input = [
        { type: 'text', text: enhancedText },
        ...imagePaths.map((path) => ({ type: 'local_image' as const, path })),
      ];
    } else {
      input = enhancedText;
    }

    const result = await session.send(input, { streaming: true, signal });
    const delegation = await resolveDelegations(result, session, {
      onInvoke: (prompt) => logger?.logOutput(`[Auto] 调用 Claude：${truncateForStatus(prompt)}`),
      onResult: (summary) => logger?.logOutput(`[Auto] Claude 完成：${truncateForStatus(summary.prompt)}`),
    });

    await finalizeStatusUpdates();
    unsubscribe?.();
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);
    interruptManager.complete(userId);

    saveThreadIdIfNeeded();

    const baseOutput =
      typeof delegation.response === 'string'
        ? delegation.response
        : String(delegation.response ?? '');

    // 确保 logger 存在（如果是新 thread，现在才有 threadId）
    if (!logger) {
      logger = sessionManager.ensureLogger(userId);
    }
    if (logger) {
      logger.attachThreadId(session.getThreadId());
    }

    // 记录 AI 回复（不含 token 统计，除非开启）
    if (logger) {
      logger.logOutput(baseOutput);
    }

    if (markNoteEnabled && userLogEntry) {
      try {
        appendMarkNoteEntry(workspaceRoot, userLogEntry, baseOutput);
      } catch (error) {
        logWarning('[CodexAdapter] Failed to append mark note', error);
      }
    }

    // 发送最终响应
    const renderText = baseOutput;
    
    const chunks = chunkMessage(renderText);
    if (chunks.length === 0) {
      chunks.push('');
    }

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const chunkText = chunks[i];
      const escapedV2 = escapeTelegramMarkdownV2(chunkText);
      await ctx.reply(escapedV2, {
        parse_mode: 'MarkdownV2',
        disable_notification: silentNotifications,
      }).catch(async () => {
        // 如果 MarkdownV2 解析失败，再尝试旧 Markdown 转义
        const safeChunk = escapeTelegramMarkdown(chunkText);
        await ctx.reply(safeChunk, {
          parse_mode: 'Markdown',
          disable_notification: silentNotifications,
        }).catch(async () => {
          // 最后退回纯文本，避免泄露解析错误
          await ctx.reply(chunkText, { disable_notification: silentNotifications }).catch(() => {});
        });
      });
    }
  } catch (error) {
    if (unsubscribe) {
      unsubscribe();
    }
    cleanupImages(imagePaths);
    cleanupFiles(filePaths);

    if (!userLogEntry && logger) {
      logger.logInput(buildUserLogEntry(text, imagePaths, filePaths));
    }

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

    // 记录错误
    if (logger && !isInterrupt) {
      logger.logError(errorMsg);
    }

    if (corruptedThread) {
      logWarning('[CodexAdapter] Detected corrupted Codex thread, resetting session', error);
      sessionManager.reset(userId);
      logger = undefined;
    }

    await finalizeStatusUpdates(escapeTelegramMarkdown(replyText));
    interruptManager.complete(userId);
    const escapedV2 = escapeTelegramMarkdownV2(replyText);
    await ctx.reply(escapedV2, {
      parse_mode: 'MarkdownV2',
      disable_notification: silentNotifications,
    }).catch(async () => {
      const safe = escapeTelegramMarkdown(replyText);
      await ctx.reply(safe, {
        parse_mode: 'Markdown',
        disable_notification: silentNotifications,
      }).catch(async () => {
        await ctx.reply(replyText, { disable_notification: silentNotifications }).catch(() => {});
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
  try {
    await uploadFileToTelegram(ctx.api, ctx.chat!.id, filePath, caption);
  } catch (error) {
    throw new Error(`发送文件失败: ${(error as Error).message}`);
  }
}

export function interruptExecution(userId: number): boolean {
  return interruptManager.interrupt(userId);
}

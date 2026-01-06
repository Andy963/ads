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
import { escapeTelegramMarkdownV2 } from '../../utils/markdown.js';
import { runCollaborativeTurn } from '../../agents/hub.js';
import { appendMarkNoteEntry } from '../utils/noteLogger.js';
import {
  CODEX_THREAD_RESET_HINT,
  CodexThreadCorruptedError,
  shouldResetThread,
} from '../../codex/errors.js';
import { HistoryStore } from '../../utils/historyStore.js';
import { truncateForLog } from '../../utils/text.js';
import { createLogger } from '../../utils/logger.js';
import { stripLeadingTranslation } from '../../utils/assistantText.js';
import { formatExploredEntry, type ExploredEntry } from '../../utils/activityTracker.js';
import { ADS_STRUCTURED_OUTPUT_SCHEMA, parseStructuredOutput, type StructuredPlanItem } from '../../utils/structuredOutput.js';
import { processAdrBlocks } from '../../utils/adrRecording.js';
import { detectWorkspaceFrom } from '../../workspace/detector.js';

// 全局中断管理器
const interruptManager = new InterruptManager();
const adapterLogger = createLogger('TelegramCodexAdapter');
const historyStore = new HistoryStore({
  storagePath: path.join(process.cwd(), ".ads", "state.db"),
  namespace: "telegram",
  migrateFromPaths: [path.join(process.cwd(), ".ads", "telegram-history.json")],
  maxEntriesPerSession: 300,
  maxTextLength: 6000,
});

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
  const workspaceRoot = cwd ? path.resolve(cwd) : process.cwd();
  const adapterLogDir = path.join(workspaceRoot, '.ads', 'logs');
  const adapterLogFile = path.join(adapterLogDir, 'telegram-bot.log');
  const fallbackLogFile = path.join(adapterLogDir, 'telegram-fallback.log');
  const markNoteEnabled = options?.markNoteEnabled ?? false;
  const silentNotifications = options?.silentNotifications ?? true;
  let logDirReady = false;
  let typingTimer: NodeJS.Timeout | null = null;

  const ensureLogDir = () => {
    if (!logDirReady) {
      fs.mkdirSync(adapterLogDir, { recursive: true });
      logDirReady = true;
    }
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
      fs.appendFileSync(
        adapterLogFile,
        `${timestamp} WARN ${message}${detail ? ` | ${detail}` : ''}\n`,
      );
    } catch (fileError) {
      adapterLogger.warn('Failed to write adapter log', fileError);
    }
    adapterLogger.warn(message, error);
  };

  const recordFallback = (stage: string, original: string, escapedV2: string) => {
    try {
      ensureLogDir();
      const timestamp = new Date().toISOString();
      const entry = `${timestamp} ${stage}\nORIGINAL:\n${original}\n---\nMARKDOWN_V2:\n${escapedV2}\n\n`;
      fs.appendFileSync(fallbackLogFile, entry);
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
  const historyKey = String(userId);
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

  const startTyping = () => {
    let typingErrorLogged = false;
    const sendTyping = async () => {
      try {
        await ctx.api.sendChatAction(chatId, 'typing');
      } catch (error) {
        if (!typingErrorLogged) {
          typingErrorLogged = true;
          logWarning('[Telegram] Failed to send typing action; disabling typing indicator', error);
        }
        stopTyping();
      }
    };
    void sendTyping();
    typingTimer = setInterval(sendTyping, 4000);
  };

  const stopTyping = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  };

  const session = sessionManager.getOrCreate(userId, cwd);
  const activeAgentLabel = sessionManager.getActiveAgentLabel(userId) || 'Codex';

  const saveThreadIdIfNeeded = () => {
    const threadId = session.getThreadId();
    if (threadId) {
      const agentId = session.getActiveAgentId();
      sessionManager.saveThreadId(userId, threadId, agentId);
    }
  };

  // 尝试获取或创建 logger（如果 threadId 还没有，也会先写入日志）
  let logger = sessionManager.ensureLogger(userId);

  // 注册请求
  const signal = interruptManager.registerRequest(userId).signal;

  const STATUS_MESSAGE_LIMIT = 3600; // Telegram 限 4096，预留安全空间
  const sentMsg = await ctx.reply(`💭 [${activeAgentLabel}] 开始处理...`, {
    disable_notification: silentNotifications,
  });
  let statusMessageId = sentMsg.message_id;
  let statusMessageText = sentMsg.text ?? '💭 开始处理...';
  let statusMessageUseMarkdown = true;
  let statusUpdatesClosed = false;
  let rateLimitUntil = 0;
  let eventQueue: Promise<void> = Promise.resolve();
  let planMessageId: number | null = null;
  let lastPlanContent: string | null = null;
  let lastTodoSignature: string | null = null;
  let lastStatusEntry: string | null = null;
  let exploredMessageId: number | null = null;
  let exploredMessageText: string | null = null;
  const exploredEntries: ExploredEntry[] = [];

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

  function formatCodeBlock(text: string): string {
    const safe = text.replace(/```/g, '`​``');
    return ['```', safe || '\u200b', '```'].join('\n');
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
    if (event.phase === 'boot') {
      return null;
    }
    if (event.phase === 'completed') {
      return null;
    }
    if (event.phase === 'analysis' && event.title === '开始处理请求') {
      return null;
    }

    // todo_list 事件已由独立的 plan message 显示，不要重复添加到状态消息
    if (isTodoListEvent(event.raw)) {
      return null;
    }

    const commandItem = getCommandExecutionItem(event.raw);
    if (commandItem) {
      return null;
    }

    const icon = PHASE_ICON[event.phase] ?? '💬';
    const rawTitle = event.title || PHASE_FALLBACK[event.phase] || '处理中';
    const lines: string[] = [`${icon} ${rawTitle}`];

    // 避免在状态消息中重复展示最终回复，保持状态与内容分离；交给最终回复发 MarkdownV2
    if (event.phase === 'responding') {
      return {
        text: lines.join('\n'),
        silent: silentNotifications,
      };
    }

    if (event.detail && event.phase !== 'command') {
      const detail = event.detail.length > 500 ? `${event.detail.slice(0, 497)}...` : event.detail;
      lines.push(indent(detail));
    }

    return {
      text: lines.join('\n'),
      silent: silentNotifications,
    };
  }

  function isParseEntityError(error: unknown): error is GrammyError {
    return (
      error instanceof GrammyError &&
      error.error_code === 400 &&
      typeof error.description === 'string' &&
      /parse entities|Pre entity/i.test(error.description)
    );
  }

  async function editStatusMessage(text: string): Promise<void> {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      const content = statusMessageUseMarkdown ? escapeTelegramMarkdownV2(text) : text;
      const options = statusMessageUseMarkdown
        ? { parse_mode: 'MarkdownV2' as const }
        : { link_preview_options: { is_disabled: true as const } };
      await ctx.api.editMessageText(chatId, statusMessageId, content, options);
      rateLimitUntil = 0;
    } catch (error) {
      if (isParseEntityError(error)) {
        logWarning('[Telegram] Status markdown parse failed, falling back to plain text', error);
        statusMessageUseMarkdown = false;
        await ctx.api.editMessageText(chatId, statusMessageId, text, {
          link_preview_options: { is_disabled: true as const },
        });
        statusMessageText = text;
        return;
      }
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
      const content = statusMessageUseMarkdown ? escapeTelegramMarkdownV2(initialText) : initialText;
      const options = statusMessageUseMarkdown
        ? { parse_mode: 'MarkdownV2' as const, disable_notification: silent ?? silentNotifications }
        : {
            disable_notification: silent ?? silentNotifications,
            link_preview_options: { is_disabled: true as const },
          };
      const newMsg = await ctx.reply(content, options);
      statusMessageId = newMsg.message_id;
      statusMessageText = initialText;
      rateLimitUntil = 0;
    } catch (error) {
      if (isParseEntityError(error)) {
        logWarning('[Telegram] Status markdown parse failed, sending plain text', error);
        statusMessageUseMarkdown = false;
        const newMsg = await ctx.reply(initialText, {
          disable_notification: silent ?? silentNotifications,
          link_preview_options: { is_disabled: true as const },
        });
        statusMessageId = newMsg.message_id;
        statusMessageText = initialText;
        rateLimitUntil = 0;
        return;
      }
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
    if (trimmed === lastStatusEntry) {
      return;
    }
    const candidate = statusMessageText ? `${statusMessageText}\n${trimmed}` : trimmed;
    if (candidate.length <= STATUS_MESSAGE_LIMIT) {
      await editStatusMessage(candidate);
      statusMessageText = candidate;
    } else {
      await sendNewStatusMessage(trimmed, entry.silent);
      // 状态消息超长发了新消息，重新把 plan 固定到底部
      await resendPlanToBottom();
    }
    lastStatusEntry = trimmed;
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

  function formatStructuredPlan(items: StructuredPlanItem[]): string | null {
    if (items.length === 0) {
      return null;
    }
    const completed = items.filter((entry) => entry.completed).length;
    const lines = items.slice(0, 8).map((entry, index) => {
      const marker = entry.completed ? '✅' : '⬜️';
      const text = entry.text?.trim() || `步骤 ${index + 1}`;
      return `${marker} ${index + 1}. ${text}`;
    });
    const more = items.length > 8 ? `... 还有 ${items.length - 8} 项` : '';
    return [
      `📋 任务计划 (${completed}/${items.length})`,
      ...lines,
      more,
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildStructuredPlanSignature(items: StructuredPlanItem[]): string {
    return JSON.stringify(
      items.map((entry) => ({
        text: entry.text ?? '',
        completed: !!entry.completed,
      })),
    );
  }

  async function maybeSendStructuredPlan(items: StructuredPlanItem[]): Promise<void> {
    const signature = buildStructuredPlanSignature(items);
    if (signature === lastTodoSignature) {
      return;
    }
    const message = formatStructuredPlan(items);
    if (!message) {
      return;
    }
    lastTodoSignature = signature;
    await upsertPlanMessage(message);
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
      await ctx.api.editMessageText(chatId, planMessageId, text);
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
      await ctx.api.deleteMessage(chatId, planMessageId);
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

  // Command log functions removed - replaced by real-time explored display

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

  async function updateExploredMessage(): Promise<void> {
    if (exploredEntries.length === 0) return;
    
    const lines = ['Explored'];
    exploredEntries.forEach((entry, idx) => {
      lines.push(formatExploredEntry(entry, idx === exploredEntries.length - 1));
    });
    const text = lines.join('\n');
    
    if (text === exploredMessageText) return;
    
    try {
      if (exploredMessageId) {
        const escaped = escapeTelegramMarkdownV2('```text\n' + text + '\n```');
        await ctx.api.editMessageText(chatId, exploredMessageId, escaped, { parse_mode: 'MarkdownV2' });
        exploredMessageText = text;
      } else {
        const escaped = escapeTelegramMarkdownV2('```text\n' + text + '\n```');
        const msg = await ctx.reply(escaped, { parse_mode: 'MarkdownV2', disable_notification: silentNotifications });
        exploredMessageId = msg.message_id;
        exploredMessageText = text;
      }
    } catch (error) {
      if (error instanceof GrammyError) {
        if (error.error_code === 400 && error.description?.includes('message is not modified')) {
          return;
        }
        if (error.error_code === 429) {
          // Rate limited, skip this update
          return;
        }
      }
      // Fallback to plain text if markdown fails
      try {
        if (exploredMessageId) {
          await ctx.api.editMessageText(chatId, exploredMessageId, text);
          exploredMessageText = text;
        } else {
          const msg = await ctx.reply(text, { disable_notification: silentNotifications });
          exploredMessageId = msg.message_id;
          exploredMessageText = text;
        }
      } catch {
        // ignore fallback errors
      }
    }
  }

  function handleExploredEntry(entry: ExploredEntry): void {
    exploredEntries.push(entry);
    eventQueue = eventQueue
      .then(() => updateExploredMessage())
      .catch((error) => {
        logWarning('[CodexAdapter] Explored update error', error);
      });
  }

  function queueEvent(event: AgentEvent): void {
    eventQueue = eventQueue
      .then(async () => {
        if (statusUpdatesClosed || !interruptManager.hasActiveRequest(userId)) {
          return;
        }

        await maybeSendTodoListUpdate(event);
        // Command log is now replaced by real-time explored display
        // await maybeUpdateCommandLog(event);
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

  function queueStatusLine(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    eventQueue = eventQueue
      .then(() => {
        if (statusUpdatesClosed || !interruptManager.hasActiveRequest(userId)) {
          return;
        }
        return appendStatusEntry({ text: trimmed, silent: silentNotifications });
      })
      .catch((error) => {
        logWarning('[CodexAdapter] Status line update error', error);
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
    startTyping();
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
    if (userLogEntry) {
      historyStore.add(historyKey, { role: "user", text: userLogEntry, ts: Date.now() });
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
    const activeAgentId = session.getActiveAgentId();
    const attachFiles = activeAgentId === 'gemini';

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

    const result = await runCollaborativeTurn(session, input, {
      streaming: true,
      signal,
      outputSchema: ADS_STRUCTURED_OUTPUT_SCHEMA,
      onExploredEntry: handleExploredEntry,
      hooks: {
        onSupervisorRound: (round, directives) =>
          logger?.logOutput(`[Auto] 协作轮次 ${round}（指令块 ${directives}）`),
        onDelegationStart: ({ agentId, agentName, prompt }) => {
          logger?.logOutput(`[Auto] 调用 ${agentId}：${truncateForLog(prompt)}`);
          queueStatusLine(`🤝 ${agentName}（${agentId}）在后台执行：${truncateForLog(prompt, 140)}`);
          handleExploredEntry({
            category: "Agent",
            summary: `${agentName}（${agentId}）在后台执行：${truncateForLog(prompt, 140)}`,
            ts: Date.now(),
            source: "tool_hook",
            meta: { tool: `agent:${agentId}` },
          });
        },
        onDelegationResult: (summary) => {
          logger?.logOutput(`[Auto] ${summary.agentName} 完成：${truncateForLog(summary.prompt)}`);
          queueStatusLine(`✅ ${summary.agentName} 已完成：${truncateForLog(summary.prompt, 140)}`);
          handleExploredEntry({
            category: "Agent",
            summary: `✅ ${summary.agentName} 完成：${truncateForLog(summary.prompt, 140)}`,
            ts: Date.now(),
            source: "tool_hook",
            meta: { tool: `agent:${summary.agentId}` },
          });
        },
      },
      toolHooks: {
        onInvoke: (tool, payload) => logger?.logOutput(`[Tool] ${tool}: ${truncateForLog(payload)}`),
        onResult: (summary) =>
          logger?.logOutput(
            `[Tool] ${summary.tool} ${summary.ok ? "完成" : "失败"}: ${truncateForLog(summary.outputPreview)}`,
          ),
      },
      toolContext: { cwd: workspaceRoot, allowedDirs: [workspaceRoot], historyNamespace: "telegram", historySessionId: historyKey },
    });

    await finalizeStatusUpdates();
    stopTyping();
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
    const structured = parseStructuredOutput(cleanedOutput);
    const finalOutput =
      structured?.answer?.trim() ? structured.answer.trim() : cleanedOutput;
    if (structured?.plan?.length) {
      await maybeSendStructuredPlan(structured.plan);
    }

    const workspaceRootForAdr = detectWorkspaceFrom(workspaceRoot);
    let outputToSend = finalOutput;
    try {
      const adrProcessed = processAdrBlocks(finalOutput, workspaceRootForAdr);
      outputToSend = adrProcessed.finalText || finalOutput;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarning(`[ADR] Failed to record ADR: ${message}`, error);
      outputToSend = `${finalOutput}\n\n---\nADR warning: failed to record ADR (${message})`;
    }

    // 确保 logger 存在（如果是新 thread，现在才有 threadId）
    if (!logger) {
      logger = sessionManager.ensureLogger(userId);
    }
    if (logger) {
      logger.attachThreadId(session.getThreadId());
    }

    // 记录 AI 回复（不含 token 统计，除非开启）
    if (logger) {
      logger.logOutput(outputToSend);
    }
    historyStore.add(historyKey, { role: "ai", text: outputToSend, ts: Date.now() });

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

    // Explored is now displayed in real-time via handleExploredEntry
    stopTyping();
  } catch (error) {
    stopTyping();
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
    if (!isInterrupt) {
      historyStore.add(historyKey, { role: "status", text: errorMsg, ts: Date.now(), kind: "error" });
    }

    if (corruptedThread) {
      logWarning('[CodexAdapter] Detected corrupted Codex thread, resetting session', error);
      sessionManager.reset(userId);
      logger = undefined;
    }

    await finalizeStatusUpdates(replyText);
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

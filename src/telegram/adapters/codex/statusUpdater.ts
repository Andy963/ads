import type { CommandExecutionItem, ThreadEvent } from "../../../agents/protocol/types.js";
import { GrammyError, type Context } from "grammy";

import type { AgentEvent } from "../../../codex/events.js";
import { escapeTelegramMarkdownV2 } from "../../../utils/markdown.js";

export interface TelegramCodexStatusUpdater {
  startTyping: () => void;
  stopTyping: () => void;
  queueEvent: (event: AgentEvent) => void;
  finalize: (finalEntry?: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

interface CommandStatusEntry {
  key: string;
  command: string;
  status?: string;
  exitCode?: number;
}

const PHASE_ICON: Partial<Record<AgentEvent["phase"], string>> = {
  analysis: "💭",
  command: "⚙️",
  editing: "✏️",
  tool: "🔧",
  responding: "🗣️",
  completed: "✅",
  error: "❌",
  connection: "📡",
};

const PHASE_FALLBACK: Partial<Record<AgentEvent["phase"], string>> = {
  analysis: "分析中",
  command: "执行命令",
  editing: "编辑文件",
  tool: "调用工具",
  responding: "生成回复",
  completed: "已完成",
  error: "错误",
  connection: "网络状态",
};

function isParseEntityError(error: unknown): error is GrammyError {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    typeof error.description === "string" &&
    /parse entities|Pre entity/i.test(error.description)
  );
}

function isTodoListEvent(rawEvent: ThreadEvent): boolean {
  if (rawEvent.type !== "item.started" && rawEvent.type !== "item.updated" && rawEvent.type !== "item.completed") {
    return false;
  }
  const item = (rawEvent as { item?: { type?: unknown } }).item;
  return Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "todo_list");
}

function extractCommandExecutionItem(event: AgentEvent): CommandExecutionItem | null {
  const rawEvent = event.raw;
  if (rawEvent.type !== "item.started" && rawEvent.type !== "item.updated" && rawEvent.type !== "item.completed") {
    return null;
  }
  const rawItem = (rawEvent as { item?: unknown }).item;
  if (!rawItem || typeof rawItem !== "object") {
    return null;
  }
  const item = rawItem as { type?: unknown };
  if (item.type !== "command_execution") {
    return null;
  }
  return rawItem as CommandExecutionItem;
}

function normalizeCommandKey(item: CommandExecutionItem): string {
  return (typeof item.id === "string" && item.id.trim()) ? item.id : item.command;
}

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatCommandStatusEmoji(status: string | undefined, exitCode: number | undefined): string {
  if (status === "failed" || (exitCode !== undefined && exitCode !== 0)) {
    return "❌";
  }
  if (status === "completed" || exitCode === 0) {
    return "✅";
  }
  return "⏳";
}

export async function createTelegramCodexStatusUpdater(params: {
  ctx: Context;
  chatId: number;
  activeAgentLabel: string;
  silentNotifications: boolean;
  streamUpdateIntervalMs: number;
  isActiveRequest: () => boolean;
  logWarning: (message: string, error?: unknown) => void;
  replyToMessageId?: number;
}): Promise<TelegramCodexStatusUpdater> {
  const STATUS_MESSAGE_LIMIT = 3600;
  const COMMAND_HISTORY_LIMIT = 3;
  const effectiveStreamUpdateIntervalMs =
    Number.isFinite(params.streamUpdateIntervalMs) && params.streamUpdateIntervalMs > 0 ? Math.floor(params.streamUpdateIntervalMs) : 0;

  let rateLimitUntil = 0;
  const applyStreamUpdateCooldown = (): void => {
    if (effectiveStreamUpdateIntervalMs <= 0) {
      rateLimitUntil = 0;
      return;
    }
    rateLimitUntil = Math.max(rateLimitUntil, Date.now() + effectiveStreamUpdateIntervalMs);
  };

  const sentMsg = await params.ctx.reply(`💭 [${params.activeAgentLabel}] 开始处理...`, {
    disable_notification: params.silentNotifications,
    ...(typeof params.replyToMessageId === "number" ? { reply_parameters: { message_id: params.replyToMessageId } } : {}),
  });

  let statusMessageId = sentMsg.message_id;
  const statusMessageIds: number[] = [statusMessageId];
  let statusMessageUseMarkdown = true;
  let statusUpdatesClosed = false;

  let eventQueue: Promise<void> = Promise.resolve();
  let lastRenderedText: string | null = null;

  let currentPhase: AgentEvent["phase"] = "analysis";
  const commandHistory: CommandStatusEntry[] = [];

  let typingTimer: NodeJS.Timeout | null = null;
  const startTyping = () => {
    let typingErrorLogged = false;
    const sendTyping = async () => {
      try {
        await params.ctx.api.sendChatAction(params.chatId, "typing");
      } catch (error) {
        if (!typingErrorLogged) {
          typingErrorLogged = true;
          params.logWarning("[Telegram] Failed to send typing action; disabling typing indicator", error);
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

  const formatHeaderLine = (phase: AgentEvent["phase"]): string => {
    const icon = PHASE_ICON[phase] ?? "💬";
    const title = PHASE_FALLBACK[phase] ?? "处理中";
    return `${icon} [${params.activeAgentLabel}] ${title}`;
  };

  const formatCommandLine = (entry: CommandStatusEntry): string => {
    const emoji = formatCommandStatusEmoji(entry.status, entry.exitCode);
    const command = truncateSingleLine(entry.command, 120);
    if (entry.exitCode === undefined) {
      return `${emoji} ${command}`;
    }
    return `${emoji} ${command} (exit ${entry.exitCode})`;
  };

  const renderStatusText = (options?: { includeCommands?: boolean; overrideHeader?: string }): string => {
    const includeCommands = options?.includeCommands ?? true;
    const lines: string[] = [];
    lines.push(options?.overrideHeader ?? formatHeaderLine(currentPhase));
    if (includeCommands && commandHistory.length > 0) {
      lines.push(`🧾 最近命令（最新 ${COMMAND_HISTORY_LIMIT} 条）:`);
      for (let i = 0; i < commandHistory.length; i++) {
        lines.push(`${i + 1}. ${formatCommandLine(commandHistory[i])}`);
      }
    }
    const text = lines.join("\n").trimEnd();
    if (text.length <= STATUS_MESSAGE_LIMIT) {
      return text;
    }
    return text.slice(0, STATUS_MESSAGE_LIMIT - 1) + "…";
  };

  const editStatusMessage = async (text: string): Promise<void> => {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      const content = statusMessageUseMarkdown ? escapeTelegramMarkdownV2(text) : text;
      const options = statusMessageUseMarkdown ? { parse_mode: "MarkdownV2" as const } : { link_preview_options: { is_disabled: true as const } };
      await params.ctx.api.editMessageText(params.chatId, statusMessageId, content, options);
      applyStreamUpdateCooldown();
    } catch (error) {
      if (isParseEntityError(error)) {
        params.logWarning("[Telegram] Status markdown parse failed, falling back to plain text", error);
        statusMessageUseMarkdown = false;
        await params.ctx.api.editMessageText(params.chatId, statusMessageId, text, { link_preview_options: { is_disabled: true as const } });
        lastRenderedText = text;
        applyStreamUpdateCooldown();
        return;
      }
      if (error instanceof GrammyError && error.error_code === 400 && error.description?.includes("message is not modified")) {
        return;
      }
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        params.logWarning(`[Telegram] Status update rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await editStatusMessage(text);
      } else {
        params.logWarning("[CodexAdapter] Failed to edit status message", error);
      }
    }
  };

  const sendNewStatusMessage = async (initialText: string, silent: boolean): Promise<void> => {
    const now = Date.now();
    if (now < rateLimitUntil) {
      await new Promise((resolve) => setTimeout(resolve, rateLimitUntil - now));
    }
    try {
      const content = statusMessageUseMarkdown ? escapeTelegramMarkdownV2(initialText) : initialText;
      const replyOptions =
        typeof params.replyToMessageId === "number" ? { reply_parameters: { message_id: params.replyToMessageId } } : {};
      const options = statusMessageUseMarkdown
        ? { parse_mode: "MarkdownV2" as const, disable_notification: silent ?? params.silentNotifications, ...replyOptions }
        : {
            disable_notification: silent ?? params.silentNotifications,
            link_preview_options: { is_disabled: true as const },
            ...replyOptions,
          };
      const newMsg = await params.ctx.reply(content, options);
      statusMessageId = newMsg.message_id;
      statusMessageIds.push(statusMessageId);
      lastRenderedText = initialText;
      applyStreamUpdateCooldown();
    } catch (error) {
      if (isParseEntityError(error)) {
        params.logWarning("[Telegram] Status markdown parse failed, sending plain text", error);
        statusMessageUseMarkdown = false;
        const newMsg = await params.ctx.reply(initialText, {
          disable_notification: silent ?? params.silentNotifications,
          link_preview_options: { is_disabled: true as const },
          ...(typeof params.replyToMessageId === "number" ? { reply_parameters: { message_id: params.replyToMessageId } } : {}),
        });
        statusMessageId = newMsg.message_id;
        statusMessageIds.push(statusMessageId);
        lastRenderedText = initialText;
        applyStreamUpdateCooldown();
        return;
      }
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters?.retry_after ?? 1;
        rateLimitUntil = Date.now() + retryAfter * 1000;
        params.logWarning(`[Telegram] Sending status rate limited, retry after ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await sendNewStatusMessage(initialText, silent);
      } else {
        params.logWarning("[CodexAdapter] Failed to send status message", error);
      }
    }
  };

  const syncStatusMessage = async (text: string): Promise<void> => {
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === lastRenderedText) {
      return;
    }
    try {
      await editStatusMessage(trimmed);
      lastRenderedText = trimmed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logWarning(`[CodexAdapter] Failed to sync status message, will try sending a new one: ${message}`, error);
      await sendNewStatusMessage(trimmed, params.silentNotifications);
    }
  };

  const upsertCommandEntry = (item: CommandExecutionItem): void => {
    const key = normalizeCommandKey(item);
    const existingIndex = commandHistory.findIndex((entry) => entry.key === key);
    const next: CommandStatusEntry = {
      key,
      command: item.command,
      status: item.status,
      exitCode: item.exit_code,
    };
    if (existingIndex >= 0) {
      commandHistory[existingIndex] = next;
      return;
    }
    commandHistory.push(next);
    if (commandHistory.length > COMMAND_HISTORY_LIMIT) {
      commandHistory.splice(0, commandHistory.length - COMMAND_HISTORY_LIMIT);
    }
  };

  const queueEvent = (event: AgentEvent): void => {
    eventQueue = eventQueue
      .then(async () => {
        if (statusUpdatesClosed || !params.isActiveRequest()) {
          return;
        }
        if (event.phase === "boot" || event.phase === "completed") {
          return;
        }
        if (event.phase === "analysis" && event.title === "开始处理请求") {
          return;
        }
        if (isTodoListEvent(event.raw)) {
          return;
        }

        currentPhase = event.phase;

        const commandItem = extractCommandExecutionItem(event);
        if (commandItem) {
          upsertCommandEntry(commandItem);
        }

        const text = renderStatusText();
        await syncStatusMessage(text);
      })
      .catch((error) => {
        params.logWarning("[CodexAdapter] Status update chain error", error);
      });
  };

  const finalize = async (finalEntry?: string): Promise<void> => {
    statusUpdatesClosed = true;
    commandHistory.length = 0;
    const overrideHeader = finalEntry ? finalEntry : `🗣️ [${params.activeAgentLabel}] 发送回复...`;
    eventQueue = eventQueue
      .then(async () => {
        const text = renderStatusText({ includeCommands: false, overrideHeader });
        await syncStatusMessage(text);
      })
      .catch((error) => {
        params.logWarning("[CodexAdapter] Final status update error", error);
      });
    try {
      await eventQueue;
    } catch (error) {
      params.logWarning("[CodexAdapter] Status update flush failed", error);
    }
  };

  const cleanup = async (): Promise<void> => {
    statusUpdatesClosed = true;
    commandHistory.length = 0;
    try {
      await eventQueue;
    } catch (error) {
      params.logWarning("[CodexAdapter] Status update flush failed before cleanup", error);
    }
    for (const messageId of statusMessageIds) {
      try {
        await params.ctx.api.deleteMessage(params.chatId, messageId);
      } catch (error) {
        params.logWarning(`[Telegram] Failed to delete status message ${messageId}`, error);
        const fallback = `✅ [${params.activeAgentLabel}] 已完成`;
        try {
          await params.ctx.api.editMessageText(params.chatId, messageId, fallback, {
            link_preview_options: { is_disabled: true as const },
          });
        } catch (editError) {
          params.logWarning(`[Telegram] Failed to edit status message ${messageId} fallback`, editError);
        }
      }
    }
  };

  return {
    startTyping,
    stopTyping,
    queueEvent,
    finalize,
    cleanup,
  };
}

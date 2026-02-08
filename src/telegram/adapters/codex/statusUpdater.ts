import type { ThreadEvent } from "../../../agents/protocol/types.js";
import { GrammyError, type Context } from "grammy";

import type { AgentEvent } from "../../../codex/events.js";
import { escapeTelegramMarkdownV2 } from "../../../utils/markdown.js";

export interface TelegramCodexStatusUpdater {
  startTyping: () => void;
  stopTyping: () => void;
  queueEvent: (event: AgentEvent) => void;
  finalize: (finalEntry?: string) => Promise<void>;
}

interface StatusEntry {
  text: string;
  silent: boolean;
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

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function isTodoListEvent(rawEvent: ThreadEvent): boolean {
  if (rawEvent.type !== "item.started" && rawEvent.type !== "item.updated" && rawEvent.type !== "item.completed") {
    return false;
  }
  const item = (rawEvent as { item?: { type?: unknown } }).item;
  return Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "todo_list");
}

export async function createTelegramCodexStatusUpdater(params: {
  ctx: Context;
  chatId: number;
  activeAgentLabel: string;
  silentNotifications: boolean;
  streamUpdateIntervalMs: number;
  isActiveRequest: () => boolean;
  logWarning: (message: string, error?: unknown) => void;
}): Promise<TelegramCodexStatusUpdater> {
  const STATUS_MESSAGE_LIMIT = 3600;
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
  });

  let statusMessageId = sentMsg.message_id;
  let statusMessageText = sentMsg.text ?? "💭 开始处理...";
  let statusMessageUseMarkdown = true;
  let statusUpdatesClosed = false;

  let eventQueue: Promise<void> = Promise.resolve();
  let lastStatusEntry: string | null = null;

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

  const formatStatusEntry = (event: AgentEvent): StatusEntry | null => {
    if (event.phase === "boot" || event.phase === "completed") {
      return null;
    }
    if (event.phase === "analysis" && event.title === "开始处理请求") {
      return null;
    }
    if (isTodoListEvent(event.raw)) {
      return null;
    }

    const icon = PHASE_ICON[event.phase] ?? "💬";
    const rawTitle = event.title || PHASE_FALLBACK[event.phase] || "处理中";
    const lines: string[] = [`${icon} ${rawTitle}`];

    if (event.phase === "responding") {
      return { text: lines.join("\n"), silent: params.silentNotifications };
    }

    if (event.detail) {
      const detail = event.detail.length > 500 ? `${event.detail.slice(0, 497)}...` : event.detail;
      lines.push(indent(detail));
    }

    return { text: lines.join("\n"), silent: params.silentNotifications };
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
        statusMessageText = text;
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
      const options = statusMessageUseMarkdown
        ? { parse_mode: "MarkdownV2" as const, disable_notification: silent ?? params.silentNotifications }
        : { disable_notification: silent ?? params.silentNotifications, link_preview_options: { is_disabled: true as const } };
      const newMsg = await params.ctx.reply(content, options);
      statusMessageId = newMsg.message_id;
      statusMessageText = initialText;
      applyStreamUpdateCooldown();
    } catch (error) {
      if (isParseEntityError(error)) {
        params.logWarning("[Telegram] Status markdown parse failed, sending plain text", error);
        statusMessageUseMarkdown = false;
        const newMsg = await params.ctx.reply(initialText, { disable_notification: silent ?? params.silentNotifications, link_preview_options: { is_disabled: true as const } });
        statusMessageId = newMsg.message_id;
        statusMessageText = initialText;
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

  const appendStatusEntry = async (entry: StatusEntry): Promise<void> => {
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
    }
    lastStatusEntry = trimmed;
  };

  const queueEvent = (event: AgentEvent): void => {
    eventQueue = eventQueue
      .then(async () => {
        if (statusUpdatesClosed || !params.isActiveRequest()) {
          return;
        }
        const entry = formatStatusEntry(event);
        if (!entry) {
          return;
        }
        await appendStatusEntry(entry);
      })
      .catch((error) => {
        params.logWarning("[CodexAdapter] Status update chain error", error);
      });
  };

  const finalize = async (finalEntry?: string): Promise<void> => {
    statusUpdatesClosed = true;
    if (finalEntry) {
      eventQueue = eventQueue
        .then(() => appendStatusEntry({ text: finalEntry, silent: params.silentNotifications }))
        .catch((error) => {
          params.logWarning("[CodexAdapter] Final status update error", error);
        });
    }
    try {
      await eventQueue;
    } catch (error) {
      params.logWarning("[CodexAdapter] Status update flush failed", error);
    }
  };

  return {
    startTyping,
    stopTyping,
    queueEvent,
    finalize,
  };
}

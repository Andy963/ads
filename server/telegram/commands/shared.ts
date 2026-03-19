import type { Context } from 'grammy';
import type { Logger } from '../../utils/logger.js';
import type { TelegramConfig } from '../config.js';
import type { SessionManager } from '../utils/sessionManager.js';
import type { DirectoryManager } from '../utils/directoryManager.js';
import type { PendingTranscriptionStore } from '../utils/pendingTranscriptions.js';

export interface TelegramBotRuntime {
  logger: Logger;
  config: TelegramConfig;
  sessionManager: SessionManager;
  directoryManager: DirectoryManager;
  pendingTranscriptions: PendingTranscriptionStore;
  silentNotifications: boolean;
  markStates: Map<number, boolean>;
}

export async function requireUserId(
  ctx: Context,
  logger: Pick<Logger, 'warn'>,
  action: string,
): Promise<number | null> {
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

export async function requirePrivateChat(
  ctx: Context,
  logger: Pick<Logger, 'warn'>,
  action: string,
): Promise<boolean> {
  const chatType = ctx.chat?.type;
  if (chatType === 'private') {
    return true;
  }
  logger.warn(`[Telegram] Non-private chat blocked for ${action}: type=${String(chatType ?? '')}`);
  if (ctx.chat) {
    await ctx.reply('❌ 该功能仅支持私聊（private chat）。');
  }
  return false;
}

export function formatTranscriptionPreview(args: {
  text: string;
  state: 'pending' | 'submitted' | 'discarded';
}): string {
  const safeText = args.text.replace(/```/g, '`​``');
  const stateLabel =
    args.state === 'pending'
      ? '📝 转录预览（不会自动发送）'
      : args.state === 'submitted'
        ? '✅ 转录预览（已提交）'
        : '🗑️ 转录预览（已丢弃）';

  const footer =
    args.state === 'pending'
      ? '点击 `Submit` 发送给 Codex；点击 `Discard` 丢弃。\n如需编辑：复制后修改，再发送新消息。\n有效期：5 分钟。'
      : '如需编辑：复制后修改，再发送新消息。';

  return `${stateLabel}\n\n\`\`\`text\n${safeText || '\u200b'}\n\`\`\`\n\n${footer}`;
}

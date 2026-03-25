import type { Context } from "grammy";

import { chunkMessage } from "./chunkMessage.js";
import { renderTelegramOutbound } from "./renderOutbound.js";

type ReplyOptions = Record<string, unknown>;

export async function sendRenderedTelegramReply(args: {
  ctx: Context;
  text: string;
  silentNotifications: boolean;
  replyOptions?: ReplyOptions;
  logWarning: (message: string, error?: unknown) => void;
  recordFallback: (stage: string, original: string, escapedV2: string) => void;
}): Promise<void> {
  const chunks = chunkMessage(args.text);
  if (chunks.length === 0) {
    chunks.push("");
  }

  const sentChunks = new Set<string>();
  let loggedMarkdownFallback = false;

  for (let i = 0; i < chunks.length; i += 1) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const chunkText = chunks[i] ?? "";
    if (sentChunks.has(chunkText)) {
      continue;
    }

    const outbound = renderTelegramOutbound(chunkText);
    try {
      await args.ctx.reply(outbound.text, {
        parse_mode: outbound.parseMode,
        disable_notification: args.silentNotifications,
        link_preview_options: { is_disabled: true },
        ...(args.replyOptions ?? {}),
      });
    } catch (error) {
      args.recordFallback("chunk_markdownv2_failed", chunkText, outbound.text);
      if (!loggedMarkdownFallback) {
        loggedMarkdownFallback = true;
        args.logWarning("[Telegram] Failed to send MarkdownV2 chunk; falling back to plain text", error);
      }
      try {
        await args.ctx.reply(outbound.plainTextFallback, {
          disable_notification: args.silentNotifications,
          link_preview_options: { is_disabled: true },
          ...(args.replyOptions ?? {}),
        });
      } catch (fallbackError) {
        args.logWarning("[Telegram] Failed to send fallback chunk", fallbackError);
      }
    }

    sentChunks.add(chunkText);
  }
}

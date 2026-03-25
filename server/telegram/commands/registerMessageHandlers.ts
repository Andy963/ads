import { Bot, InlineKeyboard, type Context } from 'grammy';
import { handleCodexMessage, hasActiveCodexRequest } from '../adapters/codex.js';
import { parseBooleanFlag } from '../botSetup.js';
import { escapeTelegramMarkdownV2 } from '../../utils/markdown.js';
import { transcribeTelegramVoiceMessage } from '../utils/voiceTranscription.js';
import { parseRestartIntent, restartPm2Apps, triggerSelfRestart } from '../utils/restartIntent.js';
import { formatTranscriptionPreview, requirePrivateChat, requireUserId, type TelegramBotRuntime } from './shared.js';
import { TELEGRAM_CONTROL_COMMANDS } from './registerControlCommands.js';

async function sendToCodex(args: {
  ctx: Context;
  runtime: TelegramBotRuntime;
  userId: number;
  text: string;
  imageFileIds?: string[];
  documentFileId?: string;
  replyToMessageId?: number;
}): Promise<void> {
  const { ctx, runtime, userId, text, imageFileIds, documentFileId, replyToMessageId } = args;
  const cwd = runtime.directoryManager.getUserCwd(userId);
  await handleCodexMessage(
    ctx,
    text,
    runtime.sessionManager,
    runtime.config.streamUpdateIntervalMs,
    imageFileIds,
    documentFileId,
    cwd,
    {
      markNoteEnabled: runtime.markStates.get(userId) ?? false,
      silentNotifications: runtime.silentNotifications,
      replyToMessageId,
      scheduleCompiler: runtime.scheduleCompiler,
      scheduler: runtime.scheduler,
    },
  );
}

async function handleRestartRequest(ctx: Context, runtime: TelegramBotRuntime, userId: number, input: string): Promise<boolean> {
  const restart = parseRestartIntent(input);
  if (!restart) {
    return false;
  }

  if (!(await requirePrivateChat(ctx, runtime.logger, 'restart'))) {
    return true;
  }

  const underPm2 = typeof process.env.pm_id === 'string' && process.env.pm_id.trim().length > 0;
  const allowRestart = parseBooleanFlag(process.env.ADS_TG_ALLOW_SUICIDE_RESTART, false);
  if (!underPm2 && !allowRestart) {
    await ctx.reply('❌ 当前未启用重启：仅在 pm2 下可用（或设置 ADS_TG_ALLOW_SUICIDE_RESTART=true）。');
    return true;
  }

  if (restart.scope === 'self') {
    await ctx.reply('♻️ 正在重启 Telegram 服务…');
    runtime.logger.warn(`[Telegram] Suicide restart requested scope=self user=${userId} pm2=${underPm2}`);
    triggerSelfRestart();
    return true;
  }

  const webApp = String(process.env.ADS_PM2_APP_WEB ?? '').trim();
  if (!webApp) {
    await ctx.reply('❌ 未配置 ADS_PM2_APP_WEB，无法重启 Web（示例：ADS_PM2_APP_WEB=ads-web）。');
    return true;
  }

  try {
    await restartPm2Apps([webApp]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ 重启失败: ${message}`);
    return true;
  }

  if (restart.scope === 'web') {
    await ctx.reply('♻️ 已请求重启 Web 服务。');
    runtime.logger.warn(`[Telegram] pm2 restart requested scope=web user=${userId} app=${webApp}`);
    return true;
  }

  await ctx.reply('♻️ 已请求重启 Web 服务，正在重启 Telegram 服务…');
  runtime.logger.warn(`[Telegram] Suicide restart requested scope=all user=${userId} app=${webApp} pm2=${underPm2}`);
  triggerSelfRestart();
  return true;
}

export function registerTelegramMessageHandlers(bot: Bot<Context>, runtime: TelegramBotRuntime): void {
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption || '请描述这张图片';
    const photos = ctx.message.photo;
    const userId = await requireUserId(ctx, runtime.logger, 'message:photo');
    if (userId === null) return;

    const photo = photos[photos.length - 1];
    await sendToCodex({
      ctx,
      runtime,
      userId,
      text: caption,
      imageFileIds: photo ? [photo.file_id] : undefined,
      replyToMessageId: ctx.message.message_id,
    });
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || '';
    const userId = await requireUserId(ctx, runtime.logger, 'message:document');
    if (userId === null) return;

    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await ctx.reply('❌ 文件过大，限制 20MB');
      return;
    }

    await sendToCodex({
      ctx,
      runtime,
      userId,
      text: caption,
      documentFileId: doc.file_id,
      replyToMessageId: ctx.message.message_id,
    });
  });

  bot.on('message:voice', async (ctx) => {
    const voice = ctx.message.voice;
    const caption = ctx.message.caption || '';
    const userId = await requireUserId(ctx, runtime.logger, 'message:voice');
    if (userId === null) return;

    if (voice.file_size && voice.file_size > 20 * 1024 * 1024) {
      await ctx.reply('❌ 文件过大，限制 20MB');
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      if (typeof chatId !== 'number') {
        await ctx.reply('❌ 无法识别 chat.id');
        return;
      }

      const mimeType = typeof voice.mime_type === 'string' ? voice.mime_type : 'audio/ogg';
      const text = await transcribeTelegramVoiceMessage({
        api: ctx.api,
        fileId: voice.file_id,
        mimeType,
        caption,
      });

      const keyboard = new InlineKeyboard().text('Submit', 'vt:submit').text('Discard', 'vt:discard');
      const previewMarkdown = formatTranscriptionPreview({ text, state: 'pending' });
      const previewText = escapeTelegramMarkdownV2(previewMarkdown);

      const preview = await ctx.reply(previewText, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
        disable_notification: runtime.silentNotifications,
        reply_parameters: { message_id: ctx.message.message_id },
        link_preview_options: { is_disabled: true },
      });

      runtime.pendingTranscriptions.add({ chatId, previewMessageId: preview.message_id, text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ 语音识别失败: ${message}`, {
        disable_notification: runtime.silentNotifications,
        reply_parameters: { message_id: ctx.message.message_id },
      });
    }
  });

  bot.callbackQuery(/^vt:(submit|discard)$/, async (ctx) => {
    const userId = await requireUserId(ctx, runtime.logger, 'callbackQuery:vt');
    if (userId === null) {
      return;
    }

    const chatId = ctx.chat?.id;
    if (typeof chatId !== 'number') {
      await ctx.answerCallbackQuery({ text: '❌ 无法识别 chat.id', show_alert: true }).catch(() => undefined);
      return;
    }

    const previewMessageId = ctx.callbackQuery.message?.message_id;
    if (typeof previewMessageId !== 'number') {
      await ctx.answerCallbackQuery({ text: '❌ 无法识别预览消息', show_alert: true }).catch(() => undefined);
      return;
    }

    const data = String(ctx.callbackQuery.data ?? '');
    const action = data.split(':')[1] ?? '';

    if (action === 'discard') {
      const result = runtime.pendingTranscriptions.discard({ chatId, previewMessageId });
      if (result.status === 'expired' || result.status === 'missing') {
        await ctx.answerCallbackQuery({ text: '⏱️ 已过期', show_alert: false }).catch(() => undefined);
        return;
      }
      if (result.status === 'already_discarded') {
        await ctx.answerCallbackQuery({ text: '🗑️ 已丢弃', show_alert: false }).catch(() => undefined);
        return;
      }
      if (result.status === 'already_submitted') {
        await ctx.answerCallbackQuery({ text: '✅ 已提交', show_alert: false }).catch(() => undefined);
        return;
      }

      await ctx.answerCallbackQuery({ text: '🗑️ 已丢弃', show_alert: false }).catch(() => undefined);

      const record = runtime.pendingTranscriptions.get({ chatId, previewMessageId });
      const text = record?.text ?? '';
      const updated = escapeTelegramMarkdownV2(formatTranscriptionPreview({ text, state: 'discarded' }));
      await ctx
        .editMessageText(updated, {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [] },
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);
      return;
    }

    if (action !== 'submit') {
      await ctx.answerCallbackQuery({ text: '❌ Unknown action', show_alert: true }).catch(() => undefined);
      return;
    }

    if (hasActiveCodexRequest(userId)) {
      await ctx
        .answerCallbackQuery({ text: '⚠️ 已有请求正在执行，请稍后再提交（或用 /esc 中断）', show_alert: false })
        .catch(() => undefined);
      return;
    }

    const record = runtime.pendingTranscriptions.get({ chatId, previewMessageId });
    if (!record) {
      await ctx.answerCallbackQuery({ text: '⏱️ 已过期', show_alert: false }).catch(() => undefined);
      return;
    }

    const consume = runtime.pendingTranscriptions.consume({ chatId, previewMessageId });
    if (consume.status === 'expired' || consume.status === 'missing') {
      await ctx.answerCallbackQuery({ text: '⏱️ 已过期', show_alert: false }).catch(() => undefined);
      return;
    }
    if (consume.status === 'already_submitted') {
      await ctx.answerCallbackQuery({ text: '✅ 已提交', show_alert: false }).catch(() => undefined);
      return;
    }
    if (consume.status === 'already_discarded') {
      await ctx.answerCallbackQuery({ text: '🗑️ 已丢弃', show_alert: false }).catch(() => undefined);
      return;
    }

    await ctx.answerCallbackQuery({ text: '✅ 已提交', show_alert: false }).catch(() => undefined);

    const updated = escapeTelegramMarkdownV2(formatTranscriptionPreview({ text: consume.text, state: 'submitted' }));
    await ctx
      .editMessageText(updated, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [] },
        link_preview_options: { is_disabled: true },
      })
      .catch(() => undefined);

    await sendToCodex({
      ctx,
      runtime,
      userId,
      text: consume.text,
      replyToMessageId: previewMessageId,
    });
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = await requireUserId(ctx, runtime.logger, 'message:text');
    if (userId === null) return;

    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const firstToken = trimmed.split(/\s+/)[0] ?? '';
      const withoutSlash = firstToken.slice(1);
      const command = withoutSlash.split('@')[0]?.toLowerCase() ?? '';
      if (command && TELEGRAM_CONTROL_COMMANDS.has(command)) {
        return;
      }
      if (command) {
        await ctx.reply(`❌ 未知命令: /${command}\n用 /help 查看可用命令`);
        return;
      }
    }

    if (await handleRestartRequest(ctx, runtime, userId, trimmed)) {
      return;
    }

    await sendToCodex({
      ctx,
      runtime,
      userId,
      text,
      replyToMessageId: ctx.message.message_id,
    });
  });
}

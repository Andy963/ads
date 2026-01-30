import type { Bot, Context } from 'grammy';

export type BotLogger = { info: (message: string) => void };

export function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

export function installApiDebugLogging(bot: Bot<Context>, logger: BotLogger): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage' || method === 'sendDocument' || method === 'sendPhoto') {
      const p = payload as Record<string, unknown>;
      logger.info(`[API Debug] ${method} disable_notification=${p.disable_notification} (type: ${typeof p.disable_notification})`);
    }
    return prev(method, payload, signal);
  });
}

export function installSilentReplyMiddleware(bot: Bot<Context>, silentNotifications: boolean): void {
  bot.use(async (ctx, next) => {
    const originalReply = ctx.reply.bind(ctx);
    const wrappedReply = (text: Parameters<Context["reply"]>[0], other?: Parameters<Context["reply"]>[1]) => {
      if (!silentNotifications) {
        return originalReply(text as never, other as never);
      }
      if (other && Object.prototype.hasOwnProperty.call(other, 'disable_notification')) {
        return originalReply(text as never, other as never);
      }
      const merged = { ...(other ?? {}), disable_notification: true };
      return originalReply(text as never, merged as never);
    };
    ctx.reply = wrappedReply as Context["reply"];
    await next();
  });
}


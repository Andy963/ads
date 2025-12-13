import type { Context, NextFunction } from 'grammy';

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('TelegramRateLimit');

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function createRateLimitMiddleware(maxRequestsPerMinute: number) {
  const requestCounts = new Map<number, RateLimitRecord>();

  return async (ctx: Context, next: NextFunction) => {
    try {
      const userId = ctx.from?.id;
      if (!userId) {
        return;
      }

      const now = Date.now();
      const record = requestCounts.get(userId);

      if (!record || now > record.resetAt) {
        requestCounts.set(userId, {
          count: 1,
          resetAt: now + 60000,
        });
        await next();
        return;
      }

      if (record.count >= maxRequestsPerMinute) {
        try {
          await ctx.reply('请求过于频繁，请稍后再试');
        } catch (error) {
          logger.warn('Failed to send rate limit reply', error);
        }
        logger.warn('Rate limit exceeded');
        return;
      }

      record.count++;
      requestCounts.set(userId, record);
      await next();
    } catch (error) {
      logger.error('Unhandled middleware error', error);
      try {
        if (ctx.chat) {
          await ctx.reply('❌ 处理请求时发生错误，请稍后重试');
        }
      } catch (replyError) {
        logger.warn('Failed to send error reply', replyError);
      }
    }
  };
}

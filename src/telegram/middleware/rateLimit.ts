import type { Context, NextFunction } from 'grammy';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export function createRateLimitMiddleware(maxRequestsPerMinute: number) {
  const requestCounts = new Map<number, RateLimitRecord>();

  return async (ctx: Context, next: NextFunction) => {
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
      await ctx.reply('请求过于频繁，请稍后再试');
      console.warn(`[RateLimit] Rate limit exceeded`);
      return;
    }

    record.count++;
    requestCounts.set(userId, record);
    await next();
  };
}

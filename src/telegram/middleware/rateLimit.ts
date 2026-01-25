import type { Context, NextFunction } from 'grammy';

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('TelegramRateLimit');

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000;

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly requestCounts = new Map<number, RateLimitRecord>();
  private nextSweepAt = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly sweepIntervalMs: number,
  ) {}

  size(): number {
    return this.requestCounts.size;
  }

  consume(userId: number, now: number): { allowed: boolean; resetAt: number } {
    if (this.sweepIntervalMs > 0 && now >= this.nextSweepAt) {
      for (const [uid, record] of this.requestCounts.entries()) {
        if (now > record.resetAt) {
          this.requestCounts.delete(uid);
        }
      }
      this.nextSweepAt = now + this.sweepIntervalMs;
    }

    const record = this.requestCounts.get(userId);
    if (!record || now > record.resetAt) {
      this.requestCounts.set(userId, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return { allowed: true, resetAt: now + this.windowMs };
    }

    if (record.count >= this.maxRequests) {
      return { allowed: false, resetAt: record.resetAt };
    }

    record.count += 1;
    this.requestCounts.set(userId, record);
    return { allowed: true, resetAt: record.resetAt };
  }
}

export function createRateLimitMiddleware(maxRequestsPerMinute: number) {
  const limiter = new InMemoryRateLimiter(
    maxRequestsPerMinute,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_SWEEP_INTERVAL_MS,
  );

  return async (ctx: Context, next: NextFunction) => {
    try {
      const userId = ctx.from?.id;
      if (!userId) {
        return;
      }

      const now = Date.now();
      const decision = limiter.consume(userId, now);
      if (!decision.allowed) {
        try {
          await ctx.reply('请求过于频繁，请稍后再试');
        } catch (error) {
          logger.warn('Failed to send rate limit reply', error);
        }
        logger.warn('Rate limit exceeded');
        return;
      }
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

import type { Context, NextFunction } from 'grammy';

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('TelegramAuth');

export function createAuthMiddleware(allowedUsers: number[]) {
  return async (ctx: Context, next: NextFunction) => {
    try {
      const userId = ctx.from?.id;

      if (!userId) {
        logger.warn('Message without user ID');
        return;
      }

      if (!allowedUsers.includes(userId)) {
        try {
          await ctx.reply('您未获得授权访问此 Bot');
        } catch (error) {
          logger.warn('Failed to send unauthorized reply', error);
        }
        logger.warn('Unauthorized access attempt');
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

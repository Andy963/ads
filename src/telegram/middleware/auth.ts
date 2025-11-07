import type { Context, NextFunction } from 'grammy';

export function createAuthMiddleware(allowedUsers: number[]) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    
    if (!userId) {
      console.warn('[Auth] Message without user ID');
      return;
    }

    if (!allowedUsers.includes(userId)) {
      await ctx.reply('您未获得授权访问此 Bot');
      console.warn(`[Auth] Unauthorized access attempt from user ${userId}`);
      return;
    }

    await next();
  };
}

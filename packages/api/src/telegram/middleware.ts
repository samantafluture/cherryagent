import type { Context, NextFunction } from "grammy";

/**
 * Auth middleware — only respond to the authorized chat ID (Sam).
 * All other messages are silently ignored.
 */
export function authMiddleware(authorizedChatId: string) {
  return async (ctx: Context, next: NextFunction) => {
    const incomingId = String(ctx.chat?.id);
    if (incomingId !== authorizedChatId) {
      console.log(
        `[auth] Rejected chat ${incomingId} (expected "${authorizedChatId}")`,
      );
      return;
    }
    await next();
  };
}

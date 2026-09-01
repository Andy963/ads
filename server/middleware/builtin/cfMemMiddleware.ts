import type { AdsMiddleware, TurnContext, BeforeInputResult } from "../types.js";

export interface CfMemMiddlewareOptions {
  apiBase?: string;
  apiKey?: string;
  recallTopK?: number;
  fetchSemanticContext?: (ctx: TurnContext) => Promise<string | null>;
  ingestConversationTurn?: (ctx: TurnContext, assistantReply: string) => Promise<void>;
}

export function createCfMemMiddleware(
  options: CfMemMiddlewareOptions = {},
): AdsMiddleware {
  return {
    name: "cfMem",

    async onBeforeInput(ctx: TurnContext): Promise<BeforeInputResult | void> {
      if (!options.fetchSemanticContext) return;
      try {
        const recalled = await options.fetchSemanticContext(ctx);
        if (recalled && recalled.trim()) {
          const modifiedPrompt = `<recalled_memory>\n${recalled.trim()}\n</recalled_memory>\n\n${ctx.prompt}`;
          return { modifiedPrompt };
        }
      } catch {
        // Non-blocking fail-safe
      }
    },

    async onAfterOutput(ctx: TurnContext, assistantReply: string): Promise<void> {
      if (!options.ingestConversationTurn) return;
      try {
        await options.ingestConversationTurn(ctx, assistantReply);
      } catch {
        // Non-blocking fail-safe
      }
    },
  };
}


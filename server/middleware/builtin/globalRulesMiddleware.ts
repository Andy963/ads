import type { AdsMiddleware, TurnContext, ItemStartResult } from "../types.js";
import type { ThreadItem } from "../../agents/protocol/types.js";

export interface GlobalRulesMiddlewareOptions {
  blockedCommandPatterns?: RegExp[];
  customRulesHeader?: string;
}

const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  /\bpkill\s+(?:-[a-zA-Z0-9]+\s+)*-?f?\s*(?:ads|cli\.js)/i,
  /\bkillall\s+(?:-[a-zA-Z0-9]+\s+)*(?:node|ads)/i,
  /\bsystemctl\s+(?:--user\s+)?(?:stop|disable|mask|kill)\s+ads-(?:web|tg)/i,
];

export function createGlobalRulesMiddleware(
  options: GlobalRulesMiddlewareOptions = {},
): AdsMiddleware {
  const patterns = options.blockedCommandPatterns ?? DEFAULT_BLOCKED_COMMAND_PATTERNS;

  return {
    name: "globalRules",

    onBeforeInput(ctx: TurnContext) {
      if (!options.customRulesHeader) return;
      return {
        modifiedPrompt: `${options.customRulesHeader}\n\n${ctx.prompt}`,
      };
    },

    onItemStart(_ctx: TurnContext, item: ThreadItem): ItemStartResult | void {
      if (item.type !== "command_execution") return;
      const cmd = String(item.command ?? "").trim();
      for (const pattern of patterns) {
        if (pattern.test(cmd)) {
          return {
            blockExecution: true,
            reason: `Command blocked by security rule: ${cmd}`,
          };
        }
      }
    },
  };
}


import type { AdsMiddleware, TurnContext, ItemStartResult } from "../types.js";
import type { ThreadItem } from "../../agents/protocol/types.js";

export interface GlobalRulesMiddlewareOptions {
  blockedCommandPatterns?: RegExp[];
}
const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  /\b(?:pkill|killall)\b[\s\S]*(?:\bads(?:-web|-tg)?\b|\bcli\.js\b|\bnode(?:js)?\b)/i,
  /\bkill\b[\s\S]*(?:\$\(\s*(?:pgrep|pidof)\b[^)]*(?:ads|cli\.js|node)[^)]*\)|\bads(?:-web|-tg)?\b|\bcli\.js\b)/i,
  /\bsystemctl\s+(?:--user\s+)?(?:stop|disable|mask|kill)\s+[\s\S]*(?:\bads-web\b|\bads-tg\b)/i,
  /\b(?:rm|unlink|shred|truncate)\b[\s\S]*\.(?:db|sqlite|sqlite3)\b/i,
  /\b(?:tee|cp|mv|install)\b[\s\S]*\.(?:db|sqlite|sqlite3)\b/i,
  /(?:^|[;&|\s])(?:\d+\s*)?>{1,2}\s*[^\s]+\.(?:db|sqlite|sqlite3)\b/i,
  /(?:^|[;&|\s])(?:\d+\s*)?>{1,2}\s*["'][^"']+\.(?:db|sqlite|sqlite3)\b["']/i,
  /\bsqlite3?\b[\s\S]*\.(?:db|sqlite|sqlite3)\b[\s\S]*(?:\b(?:delete|insert|update|drop|alter|vacuum|reindex)\b)/i,
];

export function findSecurityViolation(command: string, patterns = DEFAULT_BLOCKED_COMMAND_PATTERNS): string | null {
  const normalized = String(command ?? "").trim();
  if (!normalized) return null;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(normalized)) return normalized;
  }
  return null;
}

export function createGlobalRulesMiddleware(
  options: GlobalRulesMiddlewareOptions = {},
): AdsMiddleware {
  const patterns = options.blockedCommandPatterns ?? DEFAULT_BLOCKED_COMMAND_PATTERNS;

  return {
    name: "securityGuardrails",

    onItemStart(_ctx: TurnContext, item: ThreadItem): ItemStartResult | void {
      if (item.type !== "command_execution") return;
      const cmd = String(item.command ?? "").trim();
      if (findSecurityViolation(cmd, patterns)) {
        return {
          blockExecution: true,
          reason: `Command blocked by security rule: ${cmd}`,
        };
      }
    },
  };
}

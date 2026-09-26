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

const SHELL_OPERATORS = ["&&", "||", ";", "|", "&", "\n"];

/**
 * Splits a compound shell command into its individual commands so a rule that
 * combines an operator with an ADS target only fires when both appear in the
 * same command. Separators inside quoted strings or parenthesized substitutions
 * stay with their command.
 */
export function splitShellCommands(command: string): string[] {
  const source = String(command ?? "");
  if (!source.trim()) return [];

  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let parenDepth = 0;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;

    if (quote) {
      current += char;
      if (char === "\\" && quote !== "'" && index + 1 < source.length) {
        current += source[index + 1]!;
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "\\" && index + 1 < source.length) {
      current += char + source[index + 1]!;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }
    if (parenDepth > 0) {
      current += char;
      continue;
    }

    const twoChar = source.slice(index, index + 2);
    const operator = SHELL_OPERATORS.find((candidate) => candidate === twoChar || candidate === char);
    if (operator) {
      push();
      index += operator.length - 1;
      continue;
    }

    current += char;
  }
  push();
  return segments;
}

export function findSecurityViolation(command: string, patterns = DEFAULT_BLOCKED_COMMAND_PATTERNS): string | null {
  const normalized = String(command ?? "").trim();
  if (!normalized) return null;
  // A rule must match within a single command. Without splitting, a compound
  // line such as "pkill -9 -f run-tests.js || true; ps aux | grep node" matches
  // the kill rule because pkill and node sit in different segments.
  for (const segment of splitShellCommands(normalized)) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(segment)) return segment;
    }
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

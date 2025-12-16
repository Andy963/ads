import telegramifyMarkdown from "telegramify-markdown";

type UnsupportedTagsStrategy = "escape" | "remove" | "keep";

const DEFAULT_STRATEGY: UnsupportedTagsStrategy = "escape";

/**
 * Convert Markdown into Telegram-safe MarkdownV2 using telegramify-markdown.
 * Defaults to escaping unsupported tags to avoid parse errors.
 */
export function escapeTelegramMarkdown(text: string): string {
  return toTelegramMarkdown(text);
}

/**
 * Alias for Telegram MarkdownV2 escaping.
 */
export function escapeTelegramMarkdownV2(text: string): string {
  return toTelegramMarkdown(text);
}

function toTelegramMarkdown(
  text: string,
  strategy: UnsupportedTagsStrategy = DEFAULT_STRATEGY,
): string {
  if (!text) {
    return "";
  }
  const telegramMarkdown = telegramifyMarkdown(text, strategy);
  return sanitizeTelegramMarkdownV2(telegramMarkdown);
}

function sanitizeTelegramMarkdownV2(text: string): string {
  if (!text) {
    return "";
  }

  const lines = text.split("\n");
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && /^\s*\*{3,}\s*$/.test(line)) {
      lines[index] = "────────";
    }
  }

  return lines.join("\n");
}

/**
 * Escape inline code content (used inside single backticks).
 */
export function escapeTelegramInlineCode(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(/([`\\])/g, "\\$1");
}

/**
 * Escape italic content (used inside underscores).
 */
export function escapeTelegramItalic(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(/([_\\])/g, "\\$1");
}

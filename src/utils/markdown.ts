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
  return telegramifyMarkdown(text, strategy);
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

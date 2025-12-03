const TELEGRAM_MARKDOWN_ESCAPE = new RegExp("([_*()~`+=|{}!\\[\\]])", "g");
const TELEGRAM_CODE_ESCAPE = /([`\\])/g;
// For italic text (_..._), we only need to escape underscores and backslashes
const TELEGRAM_ITALIC_ESCAPE = /([_\\])/g;
// Escape MarkdownV2 specials; include '#' to avoid parse errors in thread IDs.
const TELEGRAM_MARKDOWN_V2_ESCAPE = /([_*[\]()~`>+\-=|{}.!#\\])/g;

export function escapeTelegramMarkdown(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TELEGRAM_MARKDOWN_ESCAPE, "\\$1");
}

/**
 * Escape text for Telegram MarkdownV2 while preserving code.
 * - Keeps ``` fenced blocks intact.
 * - Keeps inline `code` blocks, only escaping backtick/backslash inside them.
 * - Escapes MarkdownV2 specials elsewhere.
 */
export function escapeTelegramMarkdownV2(text: string): string {
  if (!text) {
    return "";
  }

  const fenceSplit = text.split(/(```[\s\S]*?```)/);
  return fenceSplit
    .map((segment) => {
      if (segment.startsWith("```") && segment.endsWith("```")) {
        return segment; // preserve fenced code blocks
      }

      // Process inline code segments within this non-fence segment
      const inlineRegex = /`([^`\n]+)`/g;
      let lastIndex = 0;
      let result = "";
      let match: RegExpExecArray | null;

      while ((match = inlineRegex.exec(segment)) !== null) {
        const before = segment.slice(lastIndex, match.index);
        result += before.replace(TELEGRAM_MARKDOWN_V2_ESCAPE, "\\$1");

        const codeContent = match[1].replace(/([`\\])/g, "\\$1");
        result += "`" + codeContent + "`";

        lastIndex = match.index + match[0].length;
      }

      const tail = segment.slice(lastIndex);
      result += tail.replace(TELEGRAM_MARKDOWN_V2_ESCAPE, "\\$1");

      return result;
    })
    .join("");
}

export function escapeTelegramInlineCode(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TELEGRAM_CODE_ESCAPE, "\\$1");
}

/**
 * Escape text for use inside italic markers (_..._)
 * Only escapes underscores and backslashes, as parentheses and other
 * special characters don't need escaping inside italic blocks
 */
export function escapeTelegramItalic(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TELEGRAM_ITALIC_ESCAPE, "\\$1");
}

const TELEGRAM_MARKDOWN_ESCAPE = new RegExp("([_*()~`+=|{}!\\[\\]])", "g");
const TELEGRAM_CODE_ESCAPE = /([`\\])/g;
// For italic text (_..._), we only need to escape underscores and backslashes
const TELEGRAM_ITALIC_ESCAPE = /([_\\])/g;

export function escapeTelegramMarkdown(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TELEGRAM_MARKDOWN_ESCAPE, "\\$1");
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

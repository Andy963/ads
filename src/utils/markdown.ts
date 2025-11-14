const TELEGRAM_MARKDOWN_ESCAPE = /([_\*\[\]\(\)~`+=|{}!])/g;
const TELEGRAM_CODE_ESCAPE = /([`\\])/g;

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

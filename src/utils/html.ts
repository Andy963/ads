const HTML_ESCAPE_REGEXP = /[&<>]/g;

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeTelegramHtml(text: string): string {
  if (!text) {
    return '';
  }
  return text.replace(HTML_ESCAPE_REGEXP, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

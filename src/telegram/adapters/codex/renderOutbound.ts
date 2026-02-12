import { escapeTelegramMarkdownV2 } from "../../../utils/markdown.js";

export type TelegramParseMode = "MarkdownV2" | "HTML";

export type TelegramOutbound = {
  parseMode: TelegramParseMode;
  text: string;
  plainTextFallback: string;
  markdownV2Fallback: string;
};

function escapeTelegramHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderCollapsedHtml(raw: string): string {
  let text = escapeTelegramHtml(raw);

  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>");
  text = text.replace(/_(.+?)_/g, "<i>$1</i>");

  text = text.replace(/```([\s\S]+?)```/g, "<pre>$1</pre>");
  text = text.replace(/`(.+?)`/g, "<code>$1</code>");

  return `<blockquote expandable>${text}</blockquote>`;
}

export function renderTelegramOutbound(raw: string, options?: { collapseMinChars?: number }): TelegramOutbound {
  const plainTextFallback = String(raw ?? "");
  const markdownV2Fallback = escapeTelegramMarkdownV2(plainTextFallback);
  const collapseMinChars = Math.max(0, Math.floor(options?.collapseMinChars ?? 600));

  if (plainTextFallback.length > collapseMinChars) {
    return { parseMode: "HTML", text: renderCollapsedHtml(plainTextFallback), plainTextFallback, markdownV2Fallback };
  }

  return { parseMode: "MarkdownV2", text: markdownV2Fallback, plainTextFallback, markdownV2Fallback };
}


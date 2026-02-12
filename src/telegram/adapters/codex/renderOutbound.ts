import { escapeTelegramMarkdownV2 } from "../../../utils/markdown.js";

export type TelegramParseMode = "MarkdownV2";

export type TelegramOutbound = {
  parseMode: TelegramParseMode;
  text: string;
  plainTextFallback: string;
};

export function renderTelegramOutbound(raw: string): TelegramOutbound {
  const plainTextFallback = String(raw ?? "");
  const text = escapeTelegramMarkdownV2(plainTextFallback);
  return { parseMode: "MarkdownV2", text, plainTextFallback };
}

import enUS from "../locales/en-US";
import zhCN from "../locales/zh-CN";

export type Locale = "en-US" | "zh-CN";
export type MessageKey = keyof typeof zhCN;

const messages: Record<Locale, Record<MessageKey, string>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function resolveLocale(language?: string): Locale {
  const candidate = language ?? (typeof navigator === "undefined" ? "" : navigator.language);
  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export const locale = resolveLocale();

if (typeof document !== "undefined") {
  document.documentElement.lang = locale;
}

export function t(key: MessageKey, language: Locale = locale): string {
  return messages[language][key];
}

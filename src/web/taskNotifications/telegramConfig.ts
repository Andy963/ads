export type TelegramNotifyConfig =
  | { ok: true; botToken: string; chatId: string }
  | { ok: false; botToken: string; chatId: string };

function normalizeEnvValue(value: unknown): string {
  return String(value ?? "").trim();
}

function parseSingleTelegramAllowedUserId(raw: string): string | null {
  const ids = String(raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    return null;
  }
  const num = Number(ids[0]);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return null;
  }
  return String(num);
}

export function resolveTaskNotificationTelegramConfigFromEnv(): TelegramNotifyConfig {
  const botToken = normalizeEnvValue(process.env.TELEGRAM_BOT_TOKEN);
  const allowedUsers = normalizeEnvValue(process.env.TELEGRAM_ALLOWED_USERS);
  const chatId = parseSingleTelegramAllowedUserId(allowedUsers) ?? "";

  if (botToken && chatId) {
    return { ok: true, botToken, chatId };
  }
  return { ok: false, botToken, chatId };
}

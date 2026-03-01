export type TelegramNotifyConfig =
  | { ok: true; botToken: string; chatId: string }
  | { ok: false; botToken: string; chatId: string };

function normalizeEnvValue(value: unknown): string {
  return String(value ?? "").trim();
}

function parsePositiveIntString(raw: string): string | null {
  const num = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return null;
  }
  return String(num);
}

function parseSingleTelegramAllowedUserIdFromList(raw: string): string | null {
  const ids = String(raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    return null;
  }
  return parsePositiveIntString(ids[0] ?? "");
}

function resolveAllowedChatIdFromEnv(): string {
  const singleUserRaw = normalizeEnvValue(process.env.TELEGRAM_ALLOWED_USER_ID);
  const legacyAllowedUsersRaw = normalizeEnvValue(process.env.TELEGRAM_ALLOWED_USERS);

  if (singleUserRaw) {
    const userId = parsePositiveIntString(singleUserRaw) ?? "";
    if (!userId) {
      return "";
    }
    if (legacyAllowedUsersRaw) {
      const legacyId = parseSingleTelegramAllowedUserIdFromList(legacyAllowedUsersRaw) ?? "";
      if (!legacyId || legacyId !== userId) {
        return "";
      }
    }
    return userId;
  }

  if (legacyAllowedUsersRaw) {
    return parseSingleTelegramAllowedUserIdFromList(legacyAllowedUsersRaw) ?? "";
  }
  return "";
}

export function resolveTaskNotificationTelegramConfigFromEnv(): TelegramNotifyConfig {
  const botToken = normalizeEnvValue(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = resolveAllowedChatIdFromEnv();

  if (botToken && chatId) {
    return { ok: true, botToken, chatId };
  }
  return { ok: false, botToken, chatId };
}

export interface TelegramConnectorConfig {
  botToken: string;
  allowedUsers: number[];
  coreUrl: string;
  coreWsUrl: string;
  connectorToken?: string;
  notificationChatId?: string;
  proxyUrl?: string;
  maxRequestsPerMinute: number;
  silentNotifications: boolean;
}

function parseAllowedUsers(env: NodeJS.ProcessEnv): number[] {
  const single = env.TELEGRAM_ALLOWED_USER_ID;
  if (single && single.trim()) {
    const id = Number(single.trim());
    if (Number.isFinite(id)) return [id];
  }
  const multiple = env.TELEGRAM_ALLOWED_USERS;
  if (multiple && multiple.trim()) {
    return multiple
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  return [];
}

function resolveWsUrl(coreUrl: string, explicitWs?: string): string {
  if (explicitWs && explicitWs.trim()) {
    return explicitWs.trim();
  }
  try {
    const parsed = new URL(coreUrl);
    const proto = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${parsed.host}/ws`;
  } catch {
    return "ws://127.0.0.1:8787/ws";
  }
}

export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): TelegramConnectorConfig {
  const botToken = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const allowedUsers = parseAllowedUsers(env);
  const coreUrl = String(env.ADS_CORE_URL ?? "http://127.0.0.1:8787").trim();
  const coreWsUrl = resolveWsUrl(coreUrl, env.ADS_CORE_WS_URL);
  const connectorToken = String(env.ADS_CONNECTOR_TOKEN ?? "").trim() || undefined;
  const notificationChatId = String(env.TELEGRAM_NOTIFICATION_CHAT_ID ?? "").trim() || undefined;
  const proxyUrl = String(env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.TELEGRAM_PROXY_URL ?? "").trim() || undefined;
  const maxRequestsPerMinute = Number(env.TELEGRAM_MAX_REQUESTS_PER_MINUTE ?? 30) || 30;
  const silentRaw = String(env.TELEGRAM_SILENT_NOTIFICATIONS ?? "true").trim().toLowerCase();
  const silentNotifications = silentRaw !== "false" && silentRaw !== "0";

  return {
    botToken,
    allowedUsers,
    coreUrl,
    coreWsUrl,
    connectorToken,
    notificationChatId,
    proxyUrl,
    maxRequestsPerMinute,
    silentNotifications,
  };
}

export function validateConnectorConfig(config: TelegramConnectorConfig): void {
  if (!config.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (config.allowedUsers.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID is required");
  }
  if (!config.connectorToken) {
    throw new Error("ADS_CONNECTOR_TOKEN is required");
  }
}

import { Bot } from "grammy";
import { loadConnectorConfig, validateConnectorConfig, type TelegramConnectorConfig } from "./config.js";
import { AdsCoreClient, type AdsClientOptions } from "./client/adsClient.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRateLimitMiddleware } from "./middleware/rateLimit.js";
import { escapeTelegramMarkdownV2 } from "./utils/markdown.js";
import { chunkMessage } from "./utils/chunkMessage.js";

export function createTelegramBot(options?: {
  config?: TelegramConnectorConfig;
  client?: AdsCoreClient;
  createClient?: (options: AdsClientOptions) => AdsCoreClient;
}): {
  bot: Bot;
  client: AdsCoreClient;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const config = options?.config ?? loadConnectorConfig();
  validateConnectorConfig(config);

  const createClient = options?.createClient ?? ((clientOptions: AdsClientOptions) => new AdsCoreClient(clientOptions));
  const client = options?.client ?? createClient({
    coreUrl: config.coreUrl,
    coreWsUrl: config.coreWsUrl,
    token: config.connectorToken,
    sessionId: "telegram-notifications",
    chatSessionId: "notifications",
    autoReconnect: true,
  });
  const chatClients = new Map<string, AdsCoreClient>();
  const getChatClient = (chatId: number): AdsCoreClient => {
    const key = String(chatId);
    const existing = chatClients.get(key);
    if (existing) return existing;

    const chatClient = createClient({
      coreUrl: config.coreUrl,
      coreWsUrl: config.coreWsUrl,
      token: config.connectorToken,
      // Core session identity is partitioned by the Telegram chat ID. This
      // keeps history, reset, and interrupt actions scoped to one chat.
      sessionId: "telegram",
      chatSessionId: `chat-${key}`,
    });
    chatClients.set(key, chatClient);
    return chatClient;
  };

  const bot = new Bot(config.botToken);
  bot.use(createAuthMiddleware(config.allowedUsers));
  bot.use(createRateLimitMiddleware(config.maxRequestsPerMinute));

  client.onEvent((event) => {
    if (event.type !== "task_terminal") return;
    const taskEvent = event.event && typeof event.event === "object" ? event.event as Record<string, unknown> : event;
    const chatId = String(taskEvent.telegramChatId ?? config.notificationChatId ?? "").trim();
    if (!chatId) return;
    const status = String(taskEvent.status ?? "unknown");
    const title = String(taskEvent.title ?? taskEvent.taskId ?? "Task");
    const detail = taskEvent.error ? `\nError: ${String(taskEvent.error)}` : "";
    void bot.api.sendMessage(chatId, `ADS task ${status}: ${title}${detail}`, {
      disable_notification: config.silentNotifications,
    });
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("ADS Telegram Connector connected.\nSend prompts directly or use /new to clear session history.");
  });

  bot.command("new", async (ctx) => {
    await getChatClient(ctx.chat.id).clearHistory();
    await ctx.reply("Session reset. Ready for a new topic.");
  });

  bot.command("stop", async (ctx) => {
    await getChatClient(ctx.chat.id).sendInterrupt();
    await ctx.reply("Interrupted running turn.");
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    try {
      await ctx.replyWithChatAction("typing");
      const { finalResponse } = await getChatClient(chatId).sendPrompt({
        text,
        channel: "telegram",
        metadata: {
          telegramChatId: String(chatId),
          telegramUserId: userId,
        },
      });

      const responseText = await finalResponse;
      const markdown = escapeTelegramMarkdownV2(responseText);
      const chunks = chunkMessage(markdown);
      for (const chunk of chunks) {
        await ctx.reply(chunk, {
          parse_mode: "MarkdownV2",
          disable_notification: config.silentNotifications,
        }).catch(async () => {
          // Fallback to plain text on MarkdownV2 parse failure
          await ctx.reply(responseText, { disable_notification: config.silentNotifications });
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error executing prompt: ${message}`);
    }
  });

  return {
    bot,
    client,
    start: async () => {
      await client.connect().catch((err) => {
        console.warn(`[telegram-connector] Could not connect to ADS Core on startup: ${err.message}. Will retry on turn.`);
      });
      await bot.start();
    },
    stop: async () => {
      client.close();
      for (const chatClient of chatClients.values()) {
        chatClient.close();
      }
      chatClients.clear();
      await bot.stop();
    },
  };
}

import { Bot } from "grammy";
import { loadConnectorConfig, validateConnectorConfig, type TelegramConnectorConfig } from "./config.js";
import { AdsCoreClient, type AdsClientOptions } from "./client/adsClient.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRateLimitMiddleware } from "./middleware/rateLimit.js";
import { escapeTelegramMarkdownV2 } from "./utils/markdown.js";
import { chunkMessage } from "./utils/chunkMessage.js";
import {
  allowedReasoningEfforts,
  buildModelKeyboard,
  findModel,
  formatModelMenu,
  formatModelStatus,
  parseModelCallback,
  parseModelCommand,
} from "./modelCommands.js";

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

  bot.command("model", async (ctx) => {
    const chatClient = getChatClient(ctx.chat.id);
    try {
      await chatClient.connect();
      await chatClient.waitForWelcome();
      const models = await chatClient.getModels();
      const state = chatClient.getModelState();
      const parsed = parseModelCommand(typeof ctx.match === "string" ? ctx.match : "");
      if (!parsed.modelId) {
        await ctx.reply(formatModelMenu(models, state), { reply_markup: buildModelKeyboard(models, state.model) });
        return;
      }

      const model = findModel(models, parsed.modelId);
      if (!model) {
        await ctx.reply(`Unknown or disabled model: ${parsed.modelId}`);
        return;
      }
      if (parsed.reasoningEffort && !allowedReasoningEfforts(model).includes(parsed.reasoningEffort)) {
        await ctx.reply(`Invalid reasoning effort for ${model.modelId}: ${parsed.reasoningEffort}`);
        return;
      }
      const next = await chatClient.setModel(model.modelId, parsed.reasoningEffort);
      await ctx.reply(`Model switched to ${next.model || model.modelId}${next.reasoningEffort ? ` (${next.reasoningEffort})` : ""}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Unable to switch model: ${message}`);
    }
  });

  bot.command("status", async (ctx) => {
    const chatClient = getChatClient(ctx.chat.id);
    try {
      await chatClient.connect();
      await chatClient.waitForWelcome();
      await ctx.reply(formatModelStatus(chatClient.getModelState()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Unable to read status: ${message}`);
    }
  });

  bot.callbackQuery(/^model:/, async (ctx) => {
    const modelId = parseModelCallback(ctx.callbackQuery.data);
    if (!modelId) {
      await ctx.answerCallbackQuery({ text: "Invalid model selection", show_alert: true });
      return;
    }
    try {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        await ctx.answerCallbackQuery({ text: "This selection is not tied to a chat", show_alert: true });
        return;
      }
      const chatClient = getChatClient(chatId);
      const models = await chatClient.getModels();
      const model = findModel(models, modelId);
      if (!model) {
        await ctx.answerCallbackQuery({ text: "Unknown or disabled model", show_alert: true });
        return;
      }
      const next = await chatClient.setModel(model.modelId);
      await ctx.answerCallbackQuery({ text: `Switched to ${next.model || model.modelId}` });
      await ctx.editMessageText(formatModelMenu(models, next), { reply_markup: buildModelKeyboard(models, next.model) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.answerCallbackQuery({ text: message.slice(0, 190), show_alert: true });
    }
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
      await bot.api.setMyCommands([
        { command: "start", description: "Connect to ADS" },
        { command: "model", description: "Select the active model" },
        { command: "status", description: "Show model status" },
        { command: "new", description: "Clear session history" },
        { command: "stop", description: "Interrupt the current turn" },
      ]).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[telegram-connector] Could not register bot commands: ${message}`);
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

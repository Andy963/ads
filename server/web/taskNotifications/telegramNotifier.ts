import type { Logger } from "../../utils/logger.js";
import { TaskStore } from "../../tasks/store.js";
import { safeParseJson } from "../../utils/json.js";

import {
  claimTaskNotificationSendLease,
  getTaskNotificationRow,
  isTaskTerminalStatus,
  listDueTaskNotifications,
  markTaskNotificationNotified,
  recordTaskNotificationFailure,
  recordTaskTerminalStatus,
} from "./store.js";
import {
  resolveTaskNotificationDefaultTelegramChatIdFromEnv,
  resolveTaskNotificationTelegramBotTokenFromEnv,
} from "./telegramConfig.js";

type TelegramSendError = { ok: false; error: string; retryAfterSeconds?: number };
type TelegramSendOk = { ok: true };
export type TelegramSendResult = TelegramSendOk | TelegramSendError;

export type TelegramSender = (args: { botToken: string; chatId: string; text: string }) => Promise<TelegramSendResult>;
type TaskNotificationLogger = Pick<Logger, "info" | "warn" | "debug">;

const DEFAULT_TELEGRAM_NOTIFY_TIME_ZONE = "Asia/Shanghai";
const telegramTimestampFormatterCache = new Map<string, Intl.DateTimeFormat>();
const pendingTaskResults = new Map<string, string>();
const TELEGRAM_TEXT_LIMIT = 4000;

type StructuredSchedulerResult = {
  status?: unknown;
  summary?: unknown;
  outputs?: {
    telegram?: {
      text?: unknown;
    };
  } | null;
};

function resolveTelegramNotifyTimeZoneFromEnv(): string {
  const raw = String(process.env.ADS_TELEGRAM_NOTIFY_TIMEZONE ?? "").trim();
  if (!raw) return DEFAULT_TELEGRAM_NOTIFY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0);
    return raw;
  } catch {
    return DEFAULT_TELEGRAM_NOTIFY_TIME_ZONE;
  }
}

function createTelegramTimestampFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function getTelegramTimestampFormatterFromEnv(): Intl.DateTimeFormat {
  const timeZone = resolveTelegramNotifyTimeZoneFromEnv();
  const cached = telegramTimestampFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = createTelegramTimestampFormatter(timeZone);
  telegramTimestampFormatterCache.set(timeZone, formatter);
  return formatter;
}

function formatTelegramTimestamp(ts: number | null, formatter: Intl.DateTimeFormat): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "N/A";
  try {
    const parts = formatter.formatToParts(new Date(ts));
    const valueByType: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        valueByType[part.type] = part.value;
      }
    }
    const year = valueByType.year;
    const month = valueByType.month;
    const day = valueByType.day;
    const hour = valueByType.hour;
    const minute = valueByType.minute;
    const second = valueByType.second;
    if (!year || !month || !day || !hour || !minute || !second) return "N/A";
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  } catch {
    return "N/A";
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "N/A";
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function normalizeStatusLabel(status: string): string {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "completed") return "Completed";
  if (s === "failed") return "Failed";
  if (s === "cancelled") return "Cancelled";
  return s || "Unknown";
}

function buildTelegramText(row: {
  projectName: string;
  taskTitle: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  taskId: string;
  result?: string | null;
}): string {
  const formatter = getTelegramTimestampFormatterFromEnv();
  const started = row.startedAt ?? null;
  const completed = row.completedAt ?? null;
  const duration = started != null && completed != null ? completed - started : null;
  const statusLabel = normalizeStatusLabel(row.status);

  const lines = [
    `Task terminal: ${statusLabel}`,
    `Project: ${row.projectName || "Workspace"}`,
    `Task: ${row.taskTitle || row.taskId}`,
    `Started: ${formatTelegramTimestamp(started, formatter)}`,
    `Completed: ${formatTelegramTimestamp(completed, formatter)}`,
    `Duration: ${formatDuration(duration)}`,
  ];

  const result = String(row.result ?? "").trim();
  if (result) {
    const maxLen = 3000;
    const truncated = result.length > maxLen ? result.slice(0, maxLen) + "…" : result;
    lines.push("", "--- Result ---", truncated);
  }

  return lines.join("\n");
}

function truncateTelegramText(text: string): string {
  const normalized = String(text ?? "");
  if (normalized.length <= TELEGRAM_TEXT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, TELEGRAM_TEXT_LIMIT - 1))}…`;
}

function loadPersistedTaskResult(workspaceRoot: string, taskId: string): string | null {
  const root = String(workspaceRoot ?? "").trim();
  const id = String(taskId ?? "").trim();
  if (!root || !id) {
    return null;
  }
  try {
    const result = new TaskStore({ workspacePath: root }).getTask(id)?.result;
    const normalized = String(result ?? "").trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function interpretStructuredSchedulerTelegramResult(
  result: string | null,
): { kind: "direct"; text: string } | { kind: "skip" } | null {
  const parsed = safeParseJson<StructuredSchedulerResult>(result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "outputs")) {
    return null;
  }
  const outputs = parsed.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return null;
  }
  const text = String(outputs.telegram?.text ?? "").trim();
  if (text) {
    return { kind: "direct", text: truncateTelegramText(text) };
  }
  return { kind: "skip" };
}

function computeBackoffNextRetryAt(now: number, retryCount: number): number {
  const baseMs = 5_000;
  const maxMs = 30 * 60_000;
  const exp = Math.min(16, Math.max(0, retryCount));
  const delay = Math.min(maxMs, Math.pow(2, exp) * baseMs);
  const jitter = Math.floor(Math.random() * 1000);
  return now + delay + jitter;
}

async function defaultTelegramSender(args: { botToken: string; chatId: string; text: string }): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${args.botToken}/sendMessage`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: args.chatId, text: args.text }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `telegram_fetch_error:${message}` };
  }

  const payload: unknown = await res.json().catch(() => null);
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const okFlag = payloadObj?.ok === true;

  if (res.ok && okFlag) {
    return { ok: true };
  }

  const retryAfterSeconds = (() => {
    const parameters = payloadObj?.parameters;
    if (!parameters || typeof parameters !== "object") {
      return undefined;
    }
    const retryAfter = (parameters as { retry_after?: unknown }).retry_after;
    if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter)) {
      return undefined;
    }
    return Math.max(0, Math.floor(retryAfter));
  })();

  const description = typeof payloadObj?.description === "string" ? payloadObj.description : "";
  const errorCode = typeof payloadObj?.error_code === "number" ? payloadObj.error_code : res.status;
  const base = description ? `telegram_api_error:${errorCode}:${description}` : `telegram_api_error:${errorCode}`;
  return { ok: false, error: base, retryAfterSeconds };
}

export async function attemptSendTaskTerminalTelegramNotification(args: {
  logger: TaskNotificationLogger;
  taskId: string;
  leaseMs?: number;
  maxRetries?: number;
  sender?: TelegramSender;
}): Promise<"sent" | "skipped" | "failed"> {
  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) {
    return "skipped";
  }

  const botToken = resolveTaskNotificationTelegramBotTokenFromEnv();
  if (!botToken) {
    return "skipped";
  }

  const claimed = claimTaskNotificationSendLease({ taskId, leaseMs: args.leaseMs, maxRetries: args.maxRetries });
  if (!claimed) {
    return "skipped";
  }

  const row = getTaskNotificationRow({ taskId });
  if (!row || row.notifiedAt != null) {
    return "skipped";
  }
  if (!row.completedAt || !isTaskTerminalStatus(row.status)) {
    return "skipped";
  }
  const chatId = String(row.telegramChatId ?? "").trim() || resolveTaskNotificationDefaultTelegramChatIdFromEnv();
  if (!chatId) {
    return "skipped";
  }

  const cachedResult = pendingTaskResults.get(taskId) ?? null;
  pendingTaskResults.delete(taskId);
  const persistedResult = cachedResult ?? loadPersistedTaskResult(row.workspaceRoot, taskId);
  const structuredDelivery = interpretStructuredSchedulerTelegramResult(persistedResult);

  if (structuredDelivery?.kind === "skip") {
    markTaskNotificationNotified({ taskId });
    args.logger.info(`[Web][TaskNotifications] Telegram skipped taskId=${taskId} status=${row.status} reason=no_telegram_output`);
    return "skipped";
  }

  const sender = args.sender ?? defaultTelegramSender;
  const text =
    structuredDelivery?.kind === "direct"
      ? structuredDelivery.text
      : buildTelegramText({
          projectName: row.projectName,
          taskTitle: row.taskTitle,
          status: row.status,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          taskId: row.taskId,
          result: persistedResult,
        });

  const result = await sender({ botToken, chatId, text });
  if (result.ok) {
    markTaskNotificationNotified({ taskId });
    args.logger.info(`[Web][TaskNotifications] Telegram notified taskId=${taskId} status=${row.status}`);
    return "sent";
  }

  const now = Date.now();
  const nextRetryAt = (() => {
    if (typeof result.retryAfterSeconds === "number" && Number.isFinite(result.retryAfterSeconds) && result.retryAfterSeconds > 0) {
      return now + result.retryAfterSeconds * 1000;
    }
    return computeBackoffNextRetryAt(now, row.retryCount);
  })();

  recordTaskNotificationFailure({ taskId, error: result.error, nextRetryAt });
  args.logger.warn(
    `[Web][TaskNotifications] Telegram notify failed taskId=${taskId} status=${row.status} retryCount=${row.retryCount} err=${result.error}`,
  );
  return "failed";
}

export function notifyTaskTerminalViaTelegram(args: {
  logger: TaskNotificationLogger;
  workspaceRoot: string;
  task: { id: string; title?: string | null; status?: string | null; startedAt?: number | null; completedAt?: number | null; result?: string | null };
  terminalStatus: "completed" | "failed" | "cancelled";
  eventTs?: number;
}): void {
  const taskId = String(args.task.id ?? "").trim();
  if (!taskId) return;

  const resultText = String(args.task.result ?? "").trim();
  if (resultText) {
    pendingTaskResults.set(taskId, resultText);
  }

  const now = typeof args.eventTs === "number" && Number.isFinite(args.eventTs) ? Math.floor(args.eventTs) : Date.now();
  const title = String(args.task.title ?? "").trim() || taskId;
  const startedAt = typeof args.task.startedAt === "number" && Number.isFinite(args.task.startedAt) ? args.task.startedAt : null;
  const completedAt =
    typeof args.task.completedAt === "number" && Number.isFinite(args.task.completedAt) ? args.task.completedAt : now;

  try {
    recordTaskTerminalStatus({
      workspaceRoot: args.workspaceRoot,
      taskId,
      taskTitle: title,
      status: args.terminalStatus,
      startedAt,
      completedAt,
      now,
      logger: args.logger,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(`[Web][TaskNotifications] record terminal status failed taskId=${taskId} err=${message}`);
    return;
  }

  void attemptSendTaskTerminalTelegramNotification({ logger: args.logger, taskId }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(`[Web][TaskNotifications] Telegram notify taskId=${taskId} crashed err=${message}`);
  });
}

export function startTaskTerminalTelegramRetryLoop(args: {
  logger: TaskNotificationLogger;
  intervalMs?: number;
  limit?: number;
  maxRetries?: number;
  leaseMs?: number;
  sender?: TelegramSender;
}): () => void {
  const intervalMs =
    typeof args.intervalMs === "number" && Number.isFinite(args.intervalMs) && args.intervalMs > 0 ? Math.floor(args.intervalMs) : 30_000;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
  const maxRetries = typeof args.maxRetries === "number" && Number.isFinite(args.maxRetries) && args.maxRetries > 0 ? Math.floor(args.maxRetries) : 10;
  const leaseMs = typeof args.leaseMs === "number" && Number.isFinite(args.leaseMs) && args.leaseMs > 0 ? Math.floor(args.leaseMs) : 60_000;

  let inProgress = false;
  const tick = async () => {
    if (inProgress) return;
    if (!resolveTaskNotificationTelegramBotTokenFromEnv()) {
      return;
    }

    inProgress = true;
    try {
      const due = listDueTaskNotifications({ limit, maxRetries });
      for (const item of due) {
        await attemptSendTaskTerminalTelegramNotification({
          logger: args.logger,
          taskId: item.taskId,
          leaseMs,
          maxRetries,
          sender: args.sender,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn(`[Web][TaskNotifications] Retry loop tick failed err=${message}`);
    } finally {
      inProgress = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

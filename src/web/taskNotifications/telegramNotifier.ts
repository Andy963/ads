import type { Logger } from "../../utils/logger.js";

import {
  claimTaskNotificationSendLease,
  getTaskNotificationRow,
  listDueTaskNotifications,
  markTaskNotificationNotified,
  recordTaskNotificationFailure,
  recordTaskTerminalStatus,
} from "./store.js";

type TelegramSendError = { ok: false; error: string; retryAfterSeconds?: number };
type TelegramSendOk = { ok: true };
export type TelegramSendResult = TelegramSendOk | TelegramSendError;

export type TelegramSender = (args: { botToken: string; chatId: string; text: string }) => Promise<TelegramSendResult>;

function resolveTelegramConfig(): { ok: true; botToken: string; chatId: string } | { ok: false } {
  const botToken = String(process.env.ADS_TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = String(process.env.ADS_TELEGRAM_NOTIFY_CHAT_ID ?? "").trim();
  if (!botToken || !chatId) {
    return { ok: false };
  }
  return { ok: true, botToken, chatId };
}

function formatIso(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "N/A";
  try {
    return new Date(ts).toISOString();
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
}): string {
  const started = row.startedAt ?? null;
  const completed = row.completedAt ?? null;
  const duration = started != null && completed != null ? completed - started : null;
  const statusLabel = normalizeStatusLabel(row.status);

  return [
    `Task terminal: ${statusLabel}`,
    `Project: ${row.projectName || "Workspace"}`,
    `Task: ${row.taskTitle || row.taskId}`,
    `Started: ${formatIso(started)}`,
    `Completed: ${formatIso(completed)}`,
    `Duration: ${formatDuration(duration)}`,
    `TaskId: ${row.taskId}`,
  ].join("\n");
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
  logger: Logger;
  taskId: string;
  leaseMs?: number;
  maxRetries?: number;
  sender?: TelegramSender;
}): Promise<"sent" | "skipped" | "failed"> {
  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) {
    return "skipped";
  }

  const telegram = resolveTelegramConfig();
  if (!telegram.ok) {
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
  if (!row.completedAt || !["completed", "failed", "cancelled"].includes(row.status)) {
    return "skipped";
  }

  const sender = args.sender ?? defaultTelegramSender;
  const text = buildTelegramText({
    projectName: row.projectName,
    taskTitle: row.taskTitle,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    taskId: row.taskId,
  });

  const result = await sender({ botToken: telegram.botToken, chatId: telegram.chatId, text });
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
  logger: Logger;
  workspaceRoot: string;
  task: { id: string; title?: string | null; status?: string | null; startedAt?: number | null; completedAt?: number | null };
  terminalStatus: "completed" | "failed" | "cancelled";
  eventTs?: number;
}): void {
  const taskId = String(args.task.id ?? "").trim();
  if (!taskId) return;

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
  logger: Logger;
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
    const telegram = resolveTelegramConfig();
    if (!telegram.ok) {
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

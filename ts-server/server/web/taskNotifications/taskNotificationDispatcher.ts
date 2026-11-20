import type { Logger } from "../../utils/logger.js";

export type TaskTerminalEvent = {
  taskId: string;
  title?: string;
  status: "completed" | "failed" | "cancelled";
  workspaceRoot: string;
  startedAt?: number | null;
  completedAt?: number | null;
  result?: unknown;
  error?: unknown;
  eventTs?: number;
  telegramChatId?: string | null;
};

type TaskTerminalListener = (event: TaskTerminalEvent) => void | Promise<void>;
const listeners = new Set<TaskTerminalListener>();

export function onTaskTerminalEvent(listener: TaskTerminalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dispatchTaskTerminalEvent(
  event: TaskTerminalEvent,
  options?: { logger?: Pick<Logger, "info" | "warn" | "debug"> },
): void {
  for (const listener of listeners) {
    try {
      void listener(event);
    } catch (err) {
      options?.logger?.warn(`[TaskNotification] Listener error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

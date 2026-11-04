export interface PromptStatusTarget {
  sendMessage(text: string): Promise<number | null>;
  editMessage(messageId: number, text: string): Promise<void>;
  sendTyping(): Promise<void>;
}

export interface PromptStatusOptions {
  typingIntervalMs?: number;
  updateIntervalMs?: number;
  now?: () => number;
}

export interface PromptStatusReporter {
  start: () => Promise<void>;
  complete: () => Promise<void>;
  fail: () => Promise<void>;
  stop: () => void;
}

export type PromptStatusState = "starting" | "running" | "completed" | "failed";

export const DEFAULT_TYPING_INTERVAL_MS = 4_000;
export const DEFAULT_STATUS_UPDATE_INTERVAL_MS = 10_000;

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatPromptStatus(state: PromptStatusState, elapsedMs: number): string {
  const elapsed = formatElapsed(elapsedMs);
  switch (state) {
    case "starting":
      return "Received. Working on it...";
    case "running":
      return `Working... ${elapsed} elapsed.`;
    case "completed":
      return `Completed in ${elapsed}.`;
    case "failed":
      return `Stopped after ${elapsed}.`;
  }
}

function boundedInterval(value: number | undefined, fallback: number): number {
  const normalized = Number(value ?? fallback);
  return Number.isFinite(normalized) && normalized > 0 ? Math.max(1, Math.floor(normalized)) : fallback;
}

export function createPromptStatusReporter(
  target: PromptStatusTarget,
  options?: PromptStatusOptions,
): PromptStatusReporter {
  const now = options?.now ?? Date.now;
  const typingIntervalMs = boundedInterval(options?.typingIntervalMs, DEFAULT_TYPING_INTERVAL_MS);
  const updateIntervalMs = boundedInterval(options?.updateIntervalMs, DEFAULT_STATUS_UPDATE_INTERVAL_MS);

  let startedAt = now();
  let messageId: number | null = null;
  let stopped = true;
  let typingTimer: NodeJS.Timeout | null = null;
  let updateTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
  };

  const refreshTyping = (): void => {
    if (stopped) return;
    void target.sendTyping().catch(() => undefined);
  };

  const refreshStatus = (): void => {
    if (stopped || messageId === null) return;
    const text = formatPromptStatus("running", now() - startedAt);
    void target.editMessage(messageId, text).catch(() => undefined);
  };

  const finalize = async (state: "completed" | "failed"): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    if (messageId === null) return;
    await target.editMessage(messageId, formatPromptStatus(state, now() - startedAt)).catch(() => undefined);
  };

  return {
    async start(): Promise<void> {
      startedAt = now();
      stopped = false;
      try {
        messageId = await target.sendMessage(formatPromptStatus("starting", 0));
      } catch {
        messageId = null;
      }
      if (stopped) return;
      refreshTyping();
      typingTimer = setInterval(refreshTyping, typingIntervalMs);
      typingTimer.unref?.();
      updateTimer = setInterval(refreshStatus, updateIntervalMs);
      updateTimer.unref?.();
    },
    complete: () => finalize("completed"),
    fail: () => finalize("failed"),
    stop(): void {
      stopped = true;
      clearTimers();
    },
  };
}

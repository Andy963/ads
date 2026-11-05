export interface PromptStatusTarget {
  sendMessage(text: string): Promise<number | null>;
  editMessage(messageId: number, text: string): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  sendTyping(): Promise<void>;
}

export interface PromptStatusOptions {
  typingIntervalMs?: number;
  thinkingIntervalMs?: number;
}

export interface PromptStatusReporter {
  start: () => Promise<void>;
  complete: () => Promise<void>;
  fail: () => Promise<void>;
  stop: () => void;
}

export const DEFAULT_TYPING_INTERVAL_MS = 4_000;
export const DEFAULT_THINKING_INTERVAL_MS = 1_000;

export function formatThinkingStatus(frame: number): string {
  const normalizedFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  return `thinking${".".repeat(normalizedFrame % 4)}`;
}

function boundedInterval(value: number | undefined, fallback: number): number {
  const normalized = Number(value ?? fallback);
  return Number.isFinite(normalized) && normalized > 0 ? Math.max(1, Math.floor(normalized)) : fallback;
}

export function createPromptStatusReporter(
  target: PromptStatusTarget,
  options?: PromptStatusOptions,
): PromptStatusReporter {
  const typingIntervalMs = boundedInterval(options?.typingIntervalMs, DEFAULT_TYPING_INTERVAL_MS);
  const thinkingIntervalMs = boundedInterval(options?.thinkingIntervalMs, DEFAULT_THINKING_INTERVAL_MS);

  let messageId: number | null = null;
  let stopped = true;
  let typingTimer: NodeJS.Timeout | null = null;
  let thinkingTimer: NodeJS.Timeout | null = null;
  let thinkingFrame = 0;

  const clearTimers = (): void => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
  };

  const refreshTyping = (): void => {
    if (stopped) return;
    void target.sendTyping().catch(() => undefined);
  };

  const refreshThinking = (): void => {
    if (stopped || messageId === null) return;
    thinkingFrame = (thinkingFrame + 1) % 4;
    void target.editMessage(messageId, formatThinkingStatus(thinkingFrame)).catch(() => undefined);
  };

  const finalize = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    if (messageId === null) return;
    const completedMessageId = messageId;
    messageId = null;
    await target.deleteMessage(completedMessageId).catch(() => undefined);
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      thinkingFrame = 0;
      try {
        messageId = await target.sendMessage(formatThinkingStatus(0));
      } catch {
        messageId = null;
      }
      if (stopped) {
        if (messageId !== null) {
          await target.deleteMessage(messageId).catch(() => undefined);
          messageId = null;
        }
        return;
      }
      refreshTyping();
      typingTimer = setInterval(refreshTyping, typingIntervalMs);
      typingTimer.unref?.();
      thinkingTimer = setInterval(refreshThinking, thinkingIntervalMs);
      thinkingTimer.unref?.();
    },
    complete: finalize,
    fail: finalize,
    stop(): void {
      stopped = true;
      clearTimers();
    },
  };
}

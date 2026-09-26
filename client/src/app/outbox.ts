/**
 * Durable, cross-tab fallback for prompts that have not reached the server yet.
 *
 * Two gaps this closes:
 *
 * - The pending prompt lived in `sessionStorage`, so a refresh in a *new* tab lost
 *   it, and disconnected prompts had no durable browser-side recovery path. Both
 *   now live in `localStorage` until server intake succeeds.
 * - With storage now shared across tabs, two tabs could each replay the same queue.
 *   Every write is broadcast so siblings converge on one view. A racing double-send
 *   is still harmless: prompts keep their `clientMessageId` and the server answers
 *   the second copy with `ack.duplicate`.
 *
 * Once the server accepts a prompt, its SQLite queue is the source of truth. The
 * browser keeps each sent-but-unacknowledged fallback only until an ACK or queue
 * snapshot proves that handoff succeeded. Images are deliberately not persisted
 * because they are in-memory blobs that cannot survive a reload.
 */
export type PersistedPrompt = {
  clientMessageId: string;
  text: string;
  createdAt: number;
  agentId?: string;
  model?: string;
  modelReasoningEffort?: string;
  replayIncomplete?: boolean;
  /** The frame was handed to WebSocket, but no authoritative ACK arrived yet. */
  sentAwaitingAck?: boolean;
  /** Legacy key kept for entries written before the rename. */
  model_reasoning_effort?: string;
};

export type OutboxSnapshot = {
  /** Legacy single-prompt fallback retained for upgrade compatibility. */
  pending: PersistedPrompt | null;
  /** All normal sends handed to WebSocket before their acknowledgement arrived. */
  sent: PersistedPrompt[];
  /** Prompts still waiting their turn, in send order. */
  queued: PersistedPrompt[];
  /**
   * Client ids the user explicitly removed from a server-tracked card. The
   * durable row stays on the server, so the dismissal has to be remembered or
   * the next queue snapshot resurrects the card.
   */
  dismissed: string[];
};

export const OUTBOX_CHANNEL_NAME = "ads.outbox";

const EMPTY: OutboxSnapshot = { pending: null, sent: [], queued: [], dismissed: [] };

/** An explicit auth boundary must not replay another account's private input. */
export function clearPersistedOutboxes(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("ads.outbox.")) localStorage.removeItem(key);
    }
  } catch { /* Storage may be disabled. */ }
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("ads.pendingPrompt.")) sessionStorage.removeItem(key);
    }
  } catch { /* Storage may be disabled. */ }
}

export function outboxStorageKey(sessionId: string, chatSessionId: string): string {
  const session = String(sessionId ?? "").trim() || "unknown";
  const chat = String(chatSessionId ?? "").trim() || "main";
  return `ads.outbox.${session}.${chat}`;
}

/** Storage key used before the outbox moved off per-tab `sessionStorage`. */
export function legacyPendingPromptStorageKey(sessionId: string, chatSessionId: string): string {
  const session = String(sessionId ?? "").trim();
  const chat = String(chatSessionId ?? "").trim() || "main";
  return session ? `ads.pendingPrompt.${session}.${chat}` : `ads.pendingPrompt.unknown.${chat}`;
}

function normalizePrompt(value: unknown): PersistedPrompt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const clientMessageId = String(record.clientMessageId ?? "").trim();
  if (!clientMessageId) return null;
  const effort = String(record.modelReasoningEffort ?? record.model_reasoning_effort ?? "").trim();
  const replayIncomplete = record.replayIncomplete === true || record.replay_incomplete === true;
  const sentAwaitingAck = record.sentAwaitingAck === true;
  const prompt: PersistedPrompt = {
    clientMessageId,
    text: String(record.text ?? ""),
    createdAt: Number(record.createdAt) || Date.now(),
  };
  const agentId = String(record.agentId ?? "").trim();
  const model = String(record.model ?? "").trim();
  if (agentId) prompt.agentId = agentId;
  if (model) prompt.model = model;
  if (effort) prompt.modelReasoningEffort = effort;
  if (replayIncomplete) prompt.replayIncomplete = true;
  if (sentAwaitingAck) prompt.sentAwaitingAck = true;
  return prompt;
}

function normalizeSnapshot(value: unknown): OutboxSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const record = value as Record<string, unknown>;
  const sentRaw = Array.isArray(record.sent) ? record.sent : [];
  const queuedRaw = Array.isArray(record.queued) ? record.queued : [];
  const seen = new Set<string>();
  const sent: PersistedPrompt[] = [];
  for (const entry of sentRaw) {
    const prompt = normalizePrompt(entry);
    if (!prompt || seen.has(prompt.clientMessageId)) continue;
    seen.add(prompt.clientMessageId);
    sent.push(prompt);
  }
  const queued: PersistedPrompt[] = [];
  for (const entry of queuedRaw) {
    const prompt = normalizePrompt(entry);
    if (!prompt || seen.has(prompt.clientMessageId)) continue;
    seen.add(prompt.clientMessageId);
    queued.push(prompt);
  }
  const pending = normalizePrompt(record.pending);
  if (pending && !seen.has(pending.clientMessageId)) {
    sent.unshift(pending);
  }
  // A dismissal outranks a lingering outbox entry. This used to skip any
  // dismissal whose id was also listed in `sent`/`queued`, on the theory that a
  // live entry means the dismissal was stale. That is backwards: a card the user
  // removed is exactly the entry that keeps lingering there, so the guard
  // discarded the dismissal on the way out of storage and the next reconnect
  // rebuilt the card. Retries, the case the guard was written for, clear the
  // dismissal explicitly via `dismissed.delete` and do not rely on this.
  const dismissedRaw = Array.isArray(record.dismissed) ? record.dismissed : [];
  const dismissed: string[] = [];
  for (const entry of dismissedRaw) {
    const clientMessageId = String(entry ?? "").trim();
    if (!clientMessageId || dismissed.includes(clientMessageId)) continue;
    dismissed.push(clientMessageId);
  }
  return { pending, sent, queued, dismissed };
}

export function isEmptyOutboxSnapshot(snapshot: OutboxSnapshot): boolean {
  return !snapshot.pending
    && snapshot.sent.length === 0
    && snapshot.queued.length === 0
    && snapshot.dismissed.length === 0;
}

export type OutboxStore = ReturnType<typeof createOutboxStore>;

export function createOutboxStore(options: { channelName?: string } = {}) {
  const listeners = new Set<(key: string, snapshot: OutboxSnapshot) => void>();
  let channel: BroadcastChannel | null = null;

  const ensureChannel = (): BroadcastChannel | null => {
    if (channel) return channel;
    if (typeof BroadcastChannel === "undefined") return null;
    try {
      channel = new BroadcastChannel(options.channelName ?? OUTBOX_CHANNEL_NAME);
    } catch {
      return null;
    }
    channel.onmessage = (event: MessageEvent) => {
      const data = event?.data as { key?: unknown; snapshot?: unknown } | null;
      const key = String(data?.key ?? "").trim();
      if (!key) return;
      const snapshot = normalizeSnapshot(data?.snapshot);
      for (const listener of listeners) {
        try {
          listener(key, snapshot);
        } catch {
          // A failing listener must not stop the others.
        }
      }
    };
    return channel;
  };

  const read = (key: string): OutboxSnapshot => {
    if (!key) return EMPTY;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return EMPTY;
      return normalizeSnapshot(JSON.parse(raw) as unknown);
    } catch {
      return EMPTY;
    }
  };

  const write = (key: string, snapshot: OutboxSnapshot): void => {
    if (!key) return;
    const normalized = normalizeSnapshot(snapshot);
    try {
      if (isEmptyOutboxSnapshot(normalized)) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(normalized));
      }
    } catch {
      // Storage may be full or blocked; the in-memory queue still works.
    }
    try {
      ensureChannel()?.postMessage({ key, snapshot: normalized });
    } catch {
      // ignore
    }
  };

  const clear = (key: string): void => {
    write(key, EMPTY);
  };

  /** Adopt an entry written by the pre-outbox `sessionStorage` layout, if any. */
  const migrateLegacyPending = (args: { key: string; legacyKey: string }): void => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(args.legacyKey);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      sessionStorage.removeItem(args.legacyKey);
    } catch {
      // ignore
    }
    const legacyPending = normalizePrompt(safeParse(raw));
    if (!legacyPending) return;
    const current = read(args.key);
    if (current.pending) return;
    write(args.key, {
      pending: legacyPending,
      sent: current.sent,
      queued: current.queued,
      dismissed: current.dismissed,
    });
  };

  const subscribe = (listener: (key: string, snapshot: OutboxSnapshot) => void): (() => void) => {
    listeners.add(listener);
    ensureChannel();
    return () => {
      listeners.delete(listener);
    };
  };

  const close = (): void => {
    listeners.clear();
    try {
      channel?.close();
    } catch {
      // ignore
    }
    channel = null;
  };

  return { read, write, clear, subscribe, close, migrateLegacyPending };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

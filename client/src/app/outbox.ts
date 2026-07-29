/**
 * Durable, cross-tab outbox for prompts that have not reached the server yet.
 *
 * Two gaps this closes:
 *
 * - The pending prompt lived in `sessionStorage`, so a refresh in a *new* tab lost
 *   it, and the queue behind it was memory-only — closing the tab silently dropped
 *   everything the user had lined up. Both now live in `localStorage`.
 * - With storage now shared across tabs, two tabs could each replay the same queue.
 *   Every write is broadcast so siblings converge on one view. A racing double-send
 *   is still harmless: prompts keep their `clientMessageId` and the server answers
 *   the second copy with `ack.duplicate`.
 *
 * Images are deliberately not persisted — they are in-memory blobs that cannot
 * survive a reload, so a prompt carrying them stays memory-only.
 */
export type PersistedPrompt = {
  clientMessageId: string;
  text: string;
  createdAt: number;
  agentId?: string;
  model?: string;
  modelReasoningEffort?: string;
  /** Legacy key kept for entries written before the rename. */
  model_reasoning_effort?: string;
};

export type OutboxSnapshot = {
  /** The prompt already handed to the server, awaiting its ack. */
  pending: PersistedPrompt | null;
  /** Prompts still waiting their turn, in send order. */
  queued: PersistedPrompt[];
};

export const OUTBOX_CHANNEL_NAME = "ads.outbox";

const EMPTY: OutboxSnapshot = { pending: null, queued: [] };

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
  return prompt;
}

function normalizeSnapshot(value: unknown): OutboxSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const record = value as Record<string, unknown>;
  const queuedRaw = Array.isArray(record.queued) ? record.queued : [];
  const seen = new Set<string>();
  const queued: PersistedPrompt[] = [];
  for (const entry of queuedRaw) {
    const prompt = normalizePrompt(entry);
    if (!prompt || seen.has(prompt.clientMessageId)) continue;
    seen.add(prompt.clientMessageId);
    queued.push(prompt);
  }
  return { pending: normalizePrompt(record.pending), queued };
}

export function isEmptyOutboxSnapshot(snapshot: OutboxSnapshot): boolean {
  return !snapshot.pending && snapshot.queued.length === 0;
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
    write(args.key, { pending: legacyPending, queued: current.queued });
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

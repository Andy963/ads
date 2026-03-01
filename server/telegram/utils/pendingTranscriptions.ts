export type PendingTranscriptionState = "pending" | "submitted" | "discarded";

export type PendingTranscriptionRecord = {
  chatId: number;
  previewMessageId: number;
  text: string;
  createdAtMs: number;
  expiresAtMs: number;
  state: PendingTranscriptionState;
};

export type PendingConsumeResult =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "already_submitted" }
  | { status: "already_discarded" };

export type PendingDiscardResult =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "already_submitted" }
  | { status: "already_discarded" };

export class PendingTranscriptionStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, PendingTranscriptionRecord>();

  constructor(args?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = Math.max(1, Math.floor(args?.ttlMs ?? 5 * 60 * 1000));
    this.maxEntries = Math.max(10, Math.floor(args?.maxEntries ?? 500));
  }

  size(): number {
    return this.entries.size;
  }

  add(args: { chatId: number; previewMessageId: number; text: string; nowMs?: number }): PendingTranscriptionRecord {
    const nowMs = args.nowMs ?? Date.now();
    this.sweep(nowMs);

    const record: PendingTranscriptionRecord = {
      chatId: args.chatId,
      previewMessageId: args.previewMessageId,
      text: args.text,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      state: "pending",
    };

    this.entries.set(this.key(args.chatId, args.previewMessageId), record);
    this.enforceMaxEntries();
    return record;
  }

  get(args: { chatId: number; previewMessageId: number; nowMs?: number }): PendingTranscriptionRecord | null {
    const nowMs = args.nowMs ?? Date.now();
    const key = this.key(args.chatId, args.previewMessageId);
    const record = this.entries.get(key);
    if (!record) {
      return null;
    }
    if (record.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    return record;
  }

  consume(args: { chatId: number; previewMessageId: number; nowMs?: number }): PendingConsumeResult {
    const nowMs = args.nowMs ?? Date.now();
    const key = this.key(args.chatId, args.previewMessageId);
    const record = this.entries.get(key);
    if (!record) {
      return { status: "missing" };
    }
    if (record.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return { status: "expired" };
    }
    if (record.state === "submitted") {
      return { status: "already_submitted" };
    }
    if (record.state === "discarded") {
      return { status: "already_discarded" };
    }
    record.state = "submitted";
    return { status: "ok", text: record.text };
  }

  discard(args: { chatId: number; previewMessageId: number; nowMs?: number }): PendingDiscardResult {
    const nowMs = args.nowMs ?? Date.now();
    const key = this.key(args.chatId, args.previewMessageId);
    const record = this.entries.get(key);
    if (!record) {
      return { status: "missing" };
    }
    if (record.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return { status: "expired" };
    }
    if (record.state === "submitted") {
      return { status: "already_submitted" };
    }
    if (record.state === "discarded") {
      return { status: "already_discarded" };
    }
    record.state = "discarded";
    return { status: "ok" };
  }

  private key(chatId: number, previewMessageId: number): string {
    return `${chatId}:${previewMessageId}`;
  }

  private sweep(nowMs: number): void {
    for (const [key, record] of this.entries) {
      if (record.expiresAtMs <= nowMs) {
        this.entries.delete(key);
      }
    }
  }

  private enforceMaxEntries(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    const ordered = Array.from(this.entries.entries()).sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
    const excess = this.entries.size - this.maxEntries;
    for (let index = 0; index < excess; index += 1) {
      const key = ordered[index]?.[0];
      if (key) {
        this.entries.delete(key);
      }
    }
  }
}


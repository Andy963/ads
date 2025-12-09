import fs from "node:fs";
import path from "node:path";

export interface HistoryEntry {
  role: string;
  text: string;
  ts: number;
  kind?: string;
}

interface HistoryStoreOptions {
  storagePath?: string;
  maxEntriesPerSession?: number;
  maxTextLength?: number;
}

export class HistoryStore {
  private storagePath: string;
  private maxEntriesPerSession: number;
  private maxTextLength: number;
  private store = new Map<string, HistoryEntry[]>();

  constructor(options: HistoryStoreOptions = {}) {
    this.storagePath =
      options.storagePath ??
      path.join(process.cwd(), ".ads", "history", "history.json");
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? 200;
    this.maxTextLength = options.maxTextLength ?? 4000;
    this.load();
  }

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): void {
    const normalized = this.normalize(entry);
    if (!normalized) return;
    const existing = this.store.get(sessionId) ?? [];
    existing.push(normalized);
    const trimmed = this.trim(existing);
    this.store.set(sessionId, trimmed);
    this.persist();
  }

  clear(sessionId: string): void {
    this.store.delete(sessionId);
    this.persist();
  }

  private normalize(entry: HistoryEntry): HistoryEntry | null {
    const role = String(entry.role || "").trim();
    const text = String(entry.text ?? "").trim();
    if (!role || !text) return null;
    const truncated =
      text.length > this.maxTextLength
        ? `${text.slice(0, this.maxTextLength - 1)}…`
        : text;
    const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
    const kind =
      entry.kind && typeof entry.kind === "string"
        ? entry.kind.trim() || undefined
        : undefined;
    return { role, text: truncated, ts, kind };
  }

  private trim(items: HistoryEntry[]): HistoryEntry[] {
    if (items.length <= this.maxEntriesPerSession) {
      return items;
    }
    return items.slice(items.length - this.maxEntriesPerSession);
  }

  private load(): void {
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, HistoryEntry[]>;
      const next = new Map<string, HistoryEntry[]>();
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (!Array.isArray(value)) continue;
        const entries: HistoryEntry[] = [];
        for (const item of value) {
          const normalized = this.normalize(item);
          if (normalized) {
            entries.push(normalized);
          }
        }
        if (entries.length > 0) {
          next.set(key, this.trim(entries));
        }
      }
      this.store = next;
    } catch {
      // ignore malformed history
      this.store = new Map();
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storagePath);
      fs.mkdirSync(dir, { recursive: true });
      const obj: Record<string, HistoryEntry[]> = {};
      for (const [key, items] of this.store.entries()) {
        obj[key] = this.trim(items);
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // ignore persistence errors
    }
  }
}

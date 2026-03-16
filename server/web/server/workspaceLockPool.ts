import fs from "node:fs";
import path from "node:path";

import { AsyncLock } from "../../utils/asyncLock.js";

function normalizeWorkspaceKey(workspaceRoot: string): string {
  const raw = String(workspaceRoot ?? "").trim();
  if (!raw) {
    return path.resolve(process.cwd());
  }

  const absolute = path.resolve(raw);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export class WorkspaceLockPool {
  private readonly locks = new Map<string, AsyncLock>();
  private readonly maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    const rawMax = typeof options?.maxEntries === "number" && Number.isFinite(options.maxEntries)
      ? Math.floor(options.maxEntries)
      : 256;
    this.maxEntries = rawMax > 0 ? rawMax : 256;
  }

  get(workspaceRoot: string): AsyncLock {
    const key = normalizeWorkspaceKey(workspaceRoot);
    const existing = this.locks.get(key);
    if (existing) {
      // Refresh insertion order to behave like an LRU cache.
      this.locks.delete(key);
      this.locks.set(key, existing);
      this.evictIfNeeded(key);
      return existing;
    }
    const lock = new AsyncLock();
    this.locks.set(key, lock);
    this.evictIfNeeded(key);
    return lock;
  }

  private evictIfNeeded(preferKeepKey?: string): void {
    if (this.locks.size <= this.maxEntries) {
      return;
    }

    for (const [key, lock] of this.locks) {
      if (this.locks.size <= this.maxEntries) {
        return;
      }
      if (preferKeepKey && key === preferKeepKey) {
        continue;
      }
      if (lock.isBusy()) {
        continue;
      }
      this.locks.delete(key);
    }
  }
}

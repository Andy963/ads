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

  get(workspaceRoot: string): AsyncLock {
    const key = normalizeWorkspaceKey(workspaceRoot);
    const existing = this.locks.get(key);
    if (existing) {
      return existing;
    }
    const lock = new AsyncLock();
    this.locks.set(key, lock);
    return lock;
  }
}


import fs from "node:fs/promises";

import { resolveWorkspaceStatePath } from "../../../workspace/adsPaths.js";
import type { Logger } from "../../../utils/logger.js";
import type { TaskQueueContext } from "./manager.js";

const PURGE_THROTTLE_MS = 12 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 100;
const UNLINK_CONCURRENCY = 8;

type PurgedAttachment = { id: string; storageKey: string };

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function unlinkBestEffort(absPath: string): Promise<void> {
  try {
    await fs.unlink(absPath);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  const pending = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item).finally(() => {
      pending.delete(p);
    });
    pending.add(p);
    if (pending.size >= limit) {
      await Promise.race(pending);
    }
  }

  await Promise.allSettled(Array.from(pending));
}

export class WorkspacePurgeScheduler {
  private readonly lastPurgeAtMsByWorkspace = new Map<string, number>();
  private readonly inFlightByWorkspace = new Set<string>();
  private readonly logger: Logger;

  constructor(deps: { logger: Logger }) {
    this.logger = deps.logger;
  }

  schedule(ctx: TaskQueueContext): void {
    const workspaceRoot = ctx.workspaceRoot;
    const now = Date.now();
    const last = this.lastPurgeAtMsByWorkspace.get(workspaceRoot) ?? 0;
    if (now - last < PURGE_THROTTLE_MS) {
      return;
    }
    if (this.inFlightByWorkspace.has(workspaceRoot)) {
      return;
    }

    this.lastPurgeAtMsByWorkspace.set(workspaceRoot, now);
    this.inFlightByWorkspace.add(workspaceRoot);

    setImmediate(() => {
      void this.run(ctx).finally(() => {
        this.inFlightByWorkspace.delete(workspaceRoot);
      });
    });
  }

  private async run(ctx: TaskQueueContext): Promise<void> {
    const cutoffMs = Date.now() - ARCHIVE_RETENTION_MS;

    for (;;) {
      const batch = await ctx.lock.runExclusive(async () => {
        return ctx.taskStore.purgeArchivedCompletedTasksBatch(cutoffMs, { limit: PURGE_BATCH_SIZE });
      });

      if (!batch || batch.taskIds.length === 0) {
        return;
      }

      await this.purgeAttachmentFiles(ctx.workspaceRoot, batch.attachments);
      await yieldToEventLoop();
    }
  }

  private async purgeAttachmentFiles(workspaceRoot: string, attachments: PurgedAttachment[]): Promise<void> {
    if (attachments.length === 0) {
      return;
    }

    const absPaths = attachments
      .map((a) => resolveWorkspaceStatePath(workspaceRoot, a.storageKey))
      .filter(Boolean);

    await runWithConcurrency(absPaths, UNLINK_CONCURRENCY, async (absPath) => {
      try {
        await unlinkBestEffort(absPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[Web][purge] failed to unlink attachment path=${absPath} err=${message}`);
      }
    });
  }
}


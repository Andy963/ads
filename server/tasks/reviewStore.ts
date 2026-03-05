import crypto from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";
import { parseOptionalSqliteInt } from "../utils/sqlite.js";
import type { WorkspacePatchPayload } from "../web/gitPatch.js";

export type ReviewSnapshot = {
  id: string;
  taskId: string;
  specRef: string | null;
  patch: WorkspacePatchPayload | null;
  changedFiles: string[];
  lintSummary: string;
  testSummary: string;
  createdAt: number;
};

export type ReviewQueueItemStatus = "pending" | "running" | "passed" | "rejected" | "failed";

export type ReviewQueueItem = {
  id: string;
  taskId: string;
  snapshotId: string;
  status: ReviewQueueItemStatus;
  error: string | null;
  conclusion: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

function parseReviewQueueItemStatus(value: unknown): ReviewQueueItemStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "pending":
    case "running":
    case "passed":
    case "rejected":
    case "failed":
      return raw;
    default:
      return "pending";
  }
}

function parseSnapshotRow(row: Record<string, unknown>): ReviewSnapshot {
  const id = String(row.id ?? "").trim();
  const taskId = String(row.task_id ?? "").trim();
  if (!id || !taskId) {
    throw new Error("Invalid review snapshot row");
  }
  const specRef = row.spec_ref == null ? null : String(row.spec_ref ?? "").trim() || null;
  const patchRaw = row.patch_json == null ? "" : String(row.patch_json ?? "").trim();
  const patch = (() => {
    if (!patchRaw) return null;
    try {
      return JSON.parse(patchRaw) as WorkspacePatchPayload;
    } catch {
      return null;
    }
  })();
  const changedFiles = (() => {
    const raw = String(row.changed_files_json ?? "").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((v) => String(v ?? "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  })();
  return {
    id,
    taskId,
    specRef,
    patch,
    changedFiles,
    lintSummary: String(row.lint_summary ?? ""),
    testSummary: String(row.test_summary ?? ""),
    createdAt: parseOptionalSqliteInt(row.created_at) ?? 0,
  };
}

function parseQueueRow(row: Record<string, unknown>): ReviewQueueItem {
  const id = String(row.id ?? "").trim();
  const taskId = String(row.task_id ?? "").trim();
  const snapshotId = String(row.snapshot_id ?? "").trim();
  if (!id || !taskId || !snapshotId) {
    throw new Error("Invalid review queue row");
  }
  return {
    id,
    taskId,
    snapshotId,
    status: parseReviewQueueItemStatus(row.status),
    error: row.error == null ? null : String(row.error ?? ""),
    conclusion: row.conclusion == null ? null : String(row.conclusion ?? ""),
    createdAt: parseOptionalSqliteInt(row.created_at) ?? 0,
    startedAt: parseOptionalSqliteInt(row.started_at),
    completedAt: parseOptionalSqliteInt(row.completed_at),
  };
}

export class ReviewStore {
  private readonly db: DatabaseType;

  constructor(options?: { workspacePath?: string }) {
    this.db = getDatabase(options?.workspacePath);
  }

  createSnapshot(
    input: {
      taskId: string;
      specRef: string | null;
      patch: WorkspacePatchPayload | null;
      changedFiles: string[];
      lintSummary?: string;
      testSummary?: string;
    },
    now = Date.now(),
  ): ReviewSnapshot {
    const taskId = String(input.taskId ?? "").trim();
    if (!taskId) {
      throw new Error("taskId is required");
    }
    const id = crypto.randomUUID();
    const specRef = input.specRef == null ? null : String(input.specRef ?? "").trim() || null;
    const patchJson = input.patch ? JSON.stringify(input.patch) : null;
    const changedFilesJson = JSON.stringify((input.changedFiles ?? []).map((p) => String(p ?? "").trim()).filter(Boolean));
    const lintSummary = String(input.lintSummary ?? "");
    const testSummary = String(input.testSummary ?? "");

    this.db
      .prepare(
        `INSERT INTO review_snapshots (
          id, task_id, spec_ref,
          patch_json, changed_files_json,
          lint_summary, test_summary,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, specRef, patchJson, changedFilesJson, lintSummary, testSummary, now);

    const snapshot = this.getSnapshot(id);
    if (!snapshot) {
      throw new Error("Failed to read back created snapshot");
    }
    return snapshot;
  }

  getSnapshot(id: string): ReviewSnapshot | null {
    const snapshotId = String(id ?? "").trim();
    if (!snapshotId) return null;
    const row = this.db.prepare(`SELECT * FROM review_snapshots WHERE id = ? LIMIT 1`).get(snapshotId) as
      | Record<string, unknown>
      | undefined;
    return row ? parseSnapshotRow(row) : null;
  }

  listQueueItems(options?: { status?: ReviewQueueItemStatus; limit?: number }): ReviewQueueItem[] {
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 100;
    const status = options?.status;
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT * FROM review_queue_items
               WHERE status = ?
               ORDER BY created_at ASC, id ASC
               LIMIT ?`,
            )
            .all(status, limit)
        : this.db
            .prepare(
              `SELECT * FROM review_queue_items
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => parseQueueRow(row));
  }

  enqueueReview(input: { taskId: string; snapshotId: string }, now = Date.now()): ReviewQueueItem {
    const taskId = String(input.taskId ?? "").trim();
    const snapshotId = String(input.snapshotId ?? "").trim();
    if (!taskId || !snapshotId) {
      throw new Error("taskId and snapshotId are required");
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO review_queue_items (
          id, task_id, snapshot_id,
          status, error, conclusion,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)`,
      )
      .run(id, taskId, snapshotId, now);
    const created = this.getQueueItem(id);
    if (!created) {
      throw new Error("Failed to read back created review queue item");
    }
    return created;
  }

  getQueueItem(id: string): ReviewQueueItem | null {
    const queueId = String(id ?? "").trim();
    if (!queueId) return null;
    const row = this.db.prepare(`SELECT * FROM review_queue_items WHERE id = ? LIMIT 1`).get(queueId) as
      | Record<string, unknown>
      | undefined;
    return row ? parseQueueRow(row) : null;
  }

  getOpenQueueItemBySnapshotId(snapshotId: string): ReviewQueueItem | null {
    const id = String(snapshotId ?? "").trim();
    if (!id) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM review_queue_items
         WHERE snapshot_id = ?
           AND status IN ('pending', 'running')
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? parseQueueRow(row) : null;
  }

  claimNextPending(now = Date.now()): ReviewQueueItem | null {
    const tx = this.db.transaction((): ReviewQueueItem | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM review_queue_items
           WHERE status = 'pending'
           ORDER BY created_at ASC, id ASC
           LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const item = parseQueueRow(row);

      const updated = this.db
        .prepare(
          `UPDATE review_queue_items
           SET status = 'running', started_at = COALESCE(started_at, ?)
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, item.id) as { changes?: number };
      if (!updated || updated.changes !== 1) {
        return null;
      }
      return this.getQueueItem(item.id);
    });
    return tx();
  }

  completeItem(
    id: string,
    updates: { status: Exclude<ReviewQueueItemStatus, "pending" | "running">; error?: string | null; conclusion?: string | null },
    now = Date.now(),
  ): ReviewQueueItem {
    const queueId = String(id ?? "").trim();
    if (!queueId) {
      throw new Error("queue item id is required");
    }
    const status = updates.status;
    const error = updates.error == null ? null : String(updates.error ?? "");
    const conclusion = updates.conclusion == null ? null : String(updates.conclusion ?? "");
    this.db
      .prepare(
        `UPDATE review_queue_items
         SET status = ?, error = ?, conclusion = ?, completed_at = COALESCE(completed_at, ?)
         WHERE id = ?`,
      )
      .run(status, error, conclusion, now, queueId);
    const updated = this.getQueueItem(queueId);
    if (!updated) {
      throw new Error("Failed to read back updated review queue item");
    }
    return updated;
  }
}

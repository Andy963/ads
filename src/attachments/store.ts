import crypto from "node:crypto";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";
import type { Attachment } from "./types.js";

type SqliteStatement = StatementType<unknown[], unknown>;

function normalizeHexSha256(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(raw)) return null;
  return raw;
}

function normalizeFilename(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  // Browsers may include fake paths like "C:\\fakepath\\foo.png".
  const basename = raw.split(/[\\/]/).pop() ?? raw;
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;

  const maxLen = 200;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export class AttachmentStore {
  private readonly db: DatabaseType;

  private readonly getByIdStmt: SqliteStatement;
  private readonly getByShaStmt: SqliteStatement;
  private readonly insertStmt: SqliteStatement;
  private readonly listByTaskStmt: SqliteStatement;
  private readonly claimForTaskStmt: SqliteStatement;
  private readonly setFilenameStmt: SqliteStatement;

  constructor(options?: { workspacePath?: string }) {
    this.db = getDatabase(options?.workspacePath);

    this.getByIdStmt = this.db.prepare(`SELECT * FROM attachments WHERE id = ? LIMIT 1`);
    this.getByShaStmt = this.db.prepare(`SELECT * FROM attachments WHERE sha256 = ? LIMIT 1`);
    this.insertStmt = this.db.prepare(`
      INSERT INTO attachments (
        id,
        task_id,
        kind,
        filename,
        content_type,
        size_bytes,
        width,
        height,
        sha256,
        storage_key,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.listByTaskStmt = this.db.prepare(
      `SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
    );
    this.claimForTaskStmt = this.db.prepare(
      `UPDATE attachments
       SET task_id = ?
       WHERE id = ? AND (task_id IS NULL OR task_id = ?)`,
    );
    this.setFilenameStmt = this.db.prepare(
      `UPDATE attachments
       SET filename = ?
       WHERE id = ? AND (filename IS NULL OR TRIM(filename) = '')`,
    );
  }

  getAttachment(id: string): Attachment | null {
    const normalized = String(id ?? "").trim();
    if (!normalized) return null;
    const row = this.getByIdStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? this.toAttachment(row) : null;
  }

  getAttachmentBySha256(sha256: string): Attachment | null {
    const normalized = normalizeHexSha256(sha256);
    if (!normalized) return null;
    const row = this.getByShaStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? this.toAttachment(row) : null;
  }

  /**
   * Create or return an existing attachment by sha256.
   * The caller is responsible for persisting the bytes at `storageKey`.
   */
  createOrGetImageAttachment(input: {
    taskId?: string | null;
    filename?: string | null;
    contentType: string;
    sizeBytes: number;
    width: number;
    height: number;
    sha256: string;
    storageKey: string;
    now?: number;
  }): Attachment {
    const sha = normalizeHexSha256(input.sha256);
    if (!sha) {
      throw new Error("Invalid sha256");
    }
    const now = typeof input.now === "number" && Number.isFinite(input.now) ? Math.floor(input.now) : Date.now();
    const filename = normalizeFilename(input.filename);

    const tx = this.db.transaction((): Attachment => {
      const existing = this.getAttachmentBySha256(sha);
      if (existing) {
        if (filename && (!existing.filename || !existing.filename.trim())) {
          try {
            this.setFilenameStmt.run(filename, existing.id);
          } catch {
            // ignore
          }
          return this.getAttachment(existing.id) ?? existing;
        }
        return existing;
      }
      const id = crypto.randomUUID();
      try {
        this.insertStmt.run(
          id,
          input.taskId ?? null,
          "image",
          filename,
          input.contentType,
          Math.floor(input.sizeBytes),
          Math.floor(input.width),
          Math.floor(input.height),
          sha,
          input.storageKey,
          now,
        );
      } catch (error) {
        // Concurrent insert for same sha256: fall back to read.
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("unique")) {
          const raced = this.getAttachmentBySha256(sha);
          if (raced) return raced;
        }
        throw error;
      }
      const created = this.getAttachment(id);
      if (!created) {
        throw new Error("Failed to read created attachment");
      }
      return created;
    });

    return tx();
  }

  listAttachmentsForTask(taskId: string): Attachment[] {
    const normalized = String(taskId ?? "").trim();
    if (!normalized) return [];
    const rows = this.listByTaskStmt.all(normalized) as Record<string, unknown>[];
    return rows.map((row) => this.toAttachment(row));
  }

  /**
   * Attach existing attachments to a task.
   * - Allows claiming an attachment if task_id is NULL.
   * - Allows idempotent re-claim if task_id already equals the target taskId.
   * - Rejects attachment ids that don't exist or belong to another task.
   */
  assignAttachmentsToTask(taskId: string, attachmentIds: string[]): void {
    const normalizedTaskId = String(taskId ?? "").trim();
    if (!normalizedTaskId) {
      throw new Error("Task id is required");
    }
    const ids = attachmentIds.map((id) => String(id ?? "").trim()).filter(Boolean);
    if (ids.length === 0) return;

    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const existing = this.getAttachment(id);
        if (!existing) {
          throw new Error(`Attachment not found: ${id}`);
        }
        if (existing.kind !== "image") {
          throw new Error(`Attachment kind not supported: ${existing.kind}`);
        }
        const updated = this.claimForTaskStmt.run(normalizedTaskId, existing.id, normalizedTaskId) as { changes?: number };
        if (!updated || updated.changes !== 1) {
          const current = this.getAttachment(existing.id);
          const owner = current?.taskId ?? null;
          if (owner && owner !== normalizedTaskId) {
            throw new Error(`Attachment already assigned to another task: ${existing.id}`);
          }
          throw new Error(`Failed to assign attachment: ${existing.id}`);
        }
      }
    });

    tx();
  }

  private toAttachment(row: Record<string, unknown>): Attachment {
    return {
      id: String(row.id ?? "").trim(),
      taskId: row.task_id == null ? null : String(row.task_id ?? "").trim() || null,
      kind: String(row.kind ?? "image").trim().toLowerCase() === "image" ? "image" : "image",
      filename: row.filename == null ? null : String(row.filename ?? "").trim() || null,
      contentType: String(row.content_type ?? "application/octet-stream").trim() || "application/octet-stream",
      sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : Number.parseInt(String(row.size_bytes ?? "0"), 10) || 0,
      width: typeof row.width === "number" ? row.width : Number.parseInt(String(row.width ?? "0"), 10) || 0,
      height: typeof row.height === "number" ? row.height : Number.parseInt(String(row.height ?? "0"), 10) || 0,
      sha256: String(row.sha256 ?? "").trim().toLowerCase(),
      storageKey: String(row.storage_key ?? "").trim(),
      createdAt: typeof row.created_at === "number" ? row.created_at : Number.parseInt(String(row.created_at ?? "0"), 10) || 0,
    };
  }
}

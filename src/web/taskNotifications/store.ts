import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../../state/database.js";
import { ensureWebAuthTables } from "../auth/schema.js";
import { ensureWebProjectTables } from "../projects/schema.js";
import { deriveProjectSessionId } from "../server/projectSessionId.js";

import { ensureTaskNotificationTables } from "./schema.js";
import { resolveTaskNotificationTelegramConfigFromEnv } from "./telegramConfig.js";

export type TaskTerminalStatus = "completed" | "failed" | "cancelled";

export type TaskNotificationRow = {
  taskId: string;
  workspaceRoot: string;
  projectId: string;
  projectName: string;
  taskTitle: string;
  telegramChatId: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  notifiedAt: number | null;
  lastError: string | null;
  retryCount: number;
  nextRetryAt: number | null;
};

function normalizePathBasename(workspaceRoot: string): string {
  const trimmed = String(workspaceRoot ?? "").trim();
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  const base = path.basename(withoutTrailing);
  return base || "Workspace";
}

function resolveProjectNameAtCreate(db: DatabaseType, authUserId: string, workspaceRoot: string): string {
  const uid = String(authUserId ?? "").trim();
  const root = String(workspaceRoot ?? "").trim();
  if (!uid || !root) {
    return normalizePathBasename(root);
  }

  try {
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const row = db
      .prepare(`SELECT display_name AS name FROM web_projects WHERE user_id = ? AND workspace_root = ? LIMIT 1`)
      .get(uid, root) as { name?: unknown } | undefined;
    const name = String(row?.name ?? "").trim();
    if (name) {
      return name;
    }
  } catch {
    // ignore
  }

  return normalizePathBasename(root);
}

function mapRow(row: Record<string, unknown>): TaskNotificationRow {
  const taskId = String(row.task_id ?? "").trim();
  const workspaceRoot = String(row.workspace_root ?? "").trim();
  const projectId = String(row.project_id ?? "").trim();
  const projectName = String(row.project_name ?? "").trim();
  const taskTitle = String(row.task_title ?? "").trim();
  const telegramChatId = String(row.telegram_chat_id ?? "").trim();
  const status = String(row.status ?? "").trim();
  const startedAt = typeof row.started_at === "number" && Number.isFinite(row.started_at) ? row.started_at : row.started_at == null ? null : Number(row.started_at);
  const completedAt =
    typeof row.completed_at === "number" && Number.isFinite(row.completed_at) ? row.completed_at : row.completed_at == null ? null : Number(row.completed_at);
  const createdAt = typeof row.created_at === "number" && Number.isFinite(row.created_at) ? row.created_at : 0;
  const notifiedAt =
    typeof row.notified_at === "number" && Number.isFinite(row.notified_at) && row.notified_at > 0 ? row.notified_at : null;
  const lastError = (() => {
    const raw = String(row.last_error ?? "").trim();
    return raw ? raw : null;
  })();
  const retryCount = typeof row.retry_count === "number" && Number.isFinite(row.retry_count) ? row.retry_count : Number(row.retry_count ?? 0) || 0;
  const nextRetryAt =
    typeof row.next_retry_at === "number" && Number.isFinite(row.next_retry_at) && row.next_retry_at > 0 ? row.next_retry_at : null;

  return {
    taskId,
    workspaceRoot,
    projectId,
    projectName,
    taskTitle,
    telegramChatId,
    status,
    startedAt: startedAt != null && Number.isFinite(startedAt) ? Math.floor(startedAt) : null,
    completedAt: completedAt != null && Number.isFinite(completedAt) ? Math.floor(completedAt) : null,
    createdAt,
    notifiedAt,
    lastError,
    retryCount: Number.isFinite(retryCount) ? Math.max(0, Math.floor(retryCount)) : 0,
    nextRetryAt,
  };
}

export function upsertTaskNotificationBinding(args: {
  db?: DatabaseType;
  authUserId: string;
  workspaceRoot: string;
  taskId: string;
  taskTitle: string;
  now?: number;
  logger?: { warn: (msg: string) => void };
}): void {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  const taskId = String(args.taskId ?? "").trim();
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const taskTitle = String(args.taskTitle ?? "").trim();
  const projectId = deriveProjectSessionId(workspaceRoot);
  const projectName = resolveProjectNameAtCreate(db, args.authUserId, workspaceRoot);
  const telegram = resolveTaskNotificationTelegramConfigFromEnv();

  if (!taskId || !workspaceRoot) {
    return;
  }

  if (!telegram.ok) {
    args.logger?.warn?.(
      `[Web][TaskNotifications] Telegram config missing; set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS (single user) to enable notifications taskId=${taskId}`,
    );
  }

  db.prepare(
    `
      INSERT INTO task_notifications (
        task_id,
        workspace_root,
        project_id,
        project_name,
        task_title,
        telegram_chat_id,
        status,
        created_at,
        retry_count,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, 'created', ?, 0, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        project_id = excluded.project_id,
        project_name = CASE WHEN task_notifications.project_name != '' THEN task_notifications.project_name ELSE excluded.project_name END,
        task_title = CASE WHEN task_notifications.task_title != '' THEN task_notifications.task_title ELSE excluded.task_title END,
        telegram_chat_id = CASE WHEN task_notifications.telegram_chat_id != '' THEN task_notifications.telegram_chat_id ELSE excluded.telegram_chat_id END,
        last_error = CASE
          WHEN excluded.last_error IS NOT NULL AND excluded.last_error != '' THEN COALESCE(task_notifications.last_error, excluded.last_error)
          WHEN task_notifications.last_error = 'missing_telegram_config' AND excluded.telegram_chat_id != '' THEN NULL
          ELSE task_notifications.last_error
        END
    `,
  ).run(
    taskId,
    workspaceRoot,
    projectId,
    projectName,
    taskTitle || "Task",
    telegram.chatId,
    now,
    telegram.ok ? null : "missing_telegram_config",
  );
}

export function recordTaskTerminalStatus(args: {
  db?: DatabaseType;
  workspaceRoot: string;
  taskId: string;
  taskTitle: string;
  status: TaskTerminalStatus;
  startedAt: number | null | undefined;
  completedAt: number | null | undefined;
  now?: number;
  logger?: { warn: (msg: string) => void };
}): void {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  const taskId = String(args.taskId ?? "").trim();
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const taskTitle = String(args.taskTitle ?? "").trim() || "Task";
  const status = args.status;
  const completedAt = typeof args.completedAt === "number" && Number.isFinite(args.completedAt) ? Math.floor(args.completedAt) : now;
  const startedAt =
    typeof args.startedAt === "number" && Number.isFinite(args.startedAt) ? Math.floor(args.startedAt) : completedAt;
  const projectId = deriveProjectSessionId(workspaceRoot);
  const telegram = resolveTaskNotificationTelegramConfigFromEnv();

  if (!taskId || !workspaceRoot) {
    return;
  }

  if (!telegram.ok) {
    args.logger?.warn?.(
      `[Web][TaskNotifications] Telegram config missing; cannot notify terminal status (set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS with exactly one user ID) taskId=${taskId} status=${status}`,
    );
  }

  const fallbackProjectName = normalizePathBasename(workspaceRoot);
  db.prepare(
    `
      INSERT INTO task_notifications (
        task_id,
        workspace_root,
        project_id,
        project_name,
        task_title,
        telegram_chat_id,
        status,
        started_at,
        completed_at,
        created_at,
        retry_count,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        project_id = excluded.project_id,
        status = excluded.status,
        task_title = excluded.task_title,
        started_at = COALESCE(excluded.started_at, task_notifications.started_at),
        completed_at = COALESCE(excluded.completed_at, task_notifications.completed_at),
        telegram_chat_id = CASE WHEN task_notifications.telegram_chat_id != '' THEN task_notifications.telegram_chat_id ELSE excluded.telegram_chat_id END,
        project_name = CASE WHEN task_notifications.project_name != '' THEN task_notifications.project_name ELSE excluded.project_name END,
        last_error = CASE
          WHEN excluded.last_error IS NOT NULL AND excluded.last_error != '' THEN COALESCE(task_notifications.last_error, excluded.last_error)
          WHEN task_notifications.last_error = 'missing_telegram_config' AND excluded.telegram_chat_id != '' THEN NULL
          ELSE task_notifications.last_error
        END,
        next_retry_at = CASE
          WHEN task_notifications.notified_at IS NULL AND (task_notifications.next_retry_at IS NULL OR task_notifications.next_retry_at <= ?) THEN NULL
          ELSE task_notifications.next_retry_at
        END
    `,
  ).run(
    taskId,
    workspaceRoot,
    projectId,
    fallbackProjectName,
    taskTitle,
    telegram.chatId,
    status,
    startedAt,
    completedAt,
    now,
    telegram.ok ? null : "missing_telegram_config",
    now,
  );
}

export function listDueTaskNotifications(args: {
  db?: DatabaseType;
  now?: number;
  limit?: number;
  maxRetries?: number;
}): Array<{ taskId: string }> {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 20;
  const maxRetries = typeof args.maxRetries === "number" && Number.isFinite(args.maxRetries) && args.maxRetries > 0 ? Math.floor(args.maxRetries) : 10;

  const rows = db
    .prepare(
      `
        SELECT task_id AS taskId
        FROM task_notifications
        WHERE notified_at IS NULL
          AND completed_at IS NOT NULL
          AND status IN ('completed', 'failed', 'cancelled')
          AND retry_count < ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY COALESCE(next_retry_at, 0) ASC, completed_at ASC, created_at ASC, task_id ASC
        LIMIT ?
      `,
    )
    .all(maxRetries, now, limit) as Array<{ taskId?: unknown }>;

  return rows
    .map((row) => String(row.taskId ?? "").trim())
    .filter(Boolean)
    .map((taskId) => ({ taskId }));
}

export function claimTaskNotificationSendLease(args: {
  db?: DatabaseType;
  taskId: string;
  now?: number;
  leaseMs?: number;
  maxRetries?: number;
}): boolean {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  const leaseMs =
    typeof args.leaseMs === "number" && Number.isFinite(args.leaseMs) && args.leaseMs > 0 ? Math.floor(args.leaseMs) : 60_000;
  const maxRetries = typeof args.maxRetries === "number" && Number.isFinite(args.maxRetries) && args.maxRetries > 0 ? Math.floor(args.maxRetries) : 10;

  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) {
    return false;
  }

  const leaseUntil = now + leaseMs;
  const result = db
    .prepare(
      `
        UPDATE task_notifications
        SET next_retry_at = ?
        WHERE task_id = ?
          AND notified_at IS NULL
          AND completed_at IS NOT NULL
          AND status IN ('completed', 'failed', 'cancelled')
          AND retry_count < ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
      `,
    )
    .run(leaseUntil, taskId, maxRetries, now) as { changes?: number };

  return Boolean(result && result.changes === 1);
}

export function getTaskNotificationRow(args: { db?: DatabaseType; taskId: string }): TaskNotificationRow | null {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) {
    return null;
  }

  const row = db.prepare(`SELECT * FROM task_notifications WHERE task_id = ? LIMIT 1`).get(taskId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  const mapped = mapRow(row);
  if (!mapped.taskId) {
    return null;
  }
  return mapped;
}

export function markTaskNotificationNotified(args: { db?: DatabaseType; taskId: string; now?: number }): void {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  const taskId = String(args.taskId ?? "").trim();
  if (!taskId) {
    return;
  }

  db.prepare(
    `
      UPDATE task_notifications
      SET notified_at = ?, last_error = NULL, next_retry_at = NULL
      WHERE task_id = ? AND notified_at IS NULL
    `,
  ).run(now, taskId);
}

export function recordTaskNotificationFailure(args: {
  db?: DatabaseType;
  taskId: string;
  error: string;
  nextRetryAt: number | null;
}): void {
  const db = args.db ?? getStateDatabase();
  ensureTaskNotificationTables(db);

  const taskId = String(args.taskId ?? "").trim();
  const error = String(args.error ?? "").trim() || "unknown_error";
  const nextRetryAt = args.nextRetryAt != null && Number.isFinite(args.nextRetryAt) ? Math.floor(args.nextRetryAt) : null;
  if (!taskId) {
    return;
  }

  db.prepare(
    `
      UPDATE task_notifications
      SET last_error = ?, retry_count = retry_count + 1, next_retry_at = ?
      WHERE task_id = ? AND notified_at IS NULL
    `,
  ).run(error, nextRetryAt, taskId);
}

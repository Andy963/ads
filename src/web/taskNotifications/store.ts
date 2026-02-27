import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../../state/database.js";
import { ensureWebAuthTables } from "../auth/schema.js";
import { ensureWebProjectTables } from "../projects/schema.js";
import { deriveProjectSessionId } from "../server/projectSessionId.js";

import { ensureTaskNotificationTables } from "./schema.js";
import { resolveTaskNotificationTelegramConfigFromEnv } from "./telegramConfig.js";

export type TaskTerminalStatus = "completed" | "failed" | "cancelled";

const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled"] as const satisfies ReadonlyArray<TaskTerminalStatus>;
const TERMINAL_TASK_STATUS_SET = new Set<string>(TERMINAL_TASK_STATUSES);
const TERMINAL_TASK_STATUSES_SQL = TERMINAL_TASK_STATUSES.map((status) => `'${status}'`).join(", ");
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_LEASE_MS = 60_000;

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

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function parseFiniteNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalTimestamp(value: unknown, options: { positiveOnly?: boolean } = {}): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  const normalized = Math.floor(parsed);
  if (options.positiveOnly && normalized <= 0) {
    return null;
  }
  return normalized;
}

function parseNonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = parseFiniteNumber(value);
  if (parsed == null) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

function resolveNow(now: unknown): number {
  const parsed = parseFiniteNumber(now);
  if (parsed == null) {
    return Date.now();
  }
  return Math.floor(parsed);
}

function resolvePositiveInteger(value: unknown, fallback: number): number {
  const parsed = parseFiniteNumber(value);
  if (parsed == null) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
}

export function isTaskTerminalStatus(status: string): status is TaskTerminalStatus {
  const normalized = normalizeText(status).toLowerCase();
  return TERMINAL_TASK_STATUS_SET.has(normalized);
}

function normalizePathBasename(workspaceRoot: string): string {
  const trimmed = normalizeText(workspaceRoot);
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  const base = path.basename(withoutTrailing);
  return base || "Workspace";
}

function resolveProjectNameAtCreate(db: DatabaseType, authUserId: string, workspaceRoot: string): string {
  const uid = normalizeText(authUserId);
  const root = normalizeText(workspaceRoot);
  if (!uid || !root) {
    return normalizePathBasename(root);
  }

  try {
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const row = db
      .prepare(`SELECT display_name AS name FROM web_projects WHERE user_id = ? AND workspace_root = ? LIMIT 1`)
      .get(uid, root) as { name?: unknown } | undefined;
    const name = normalizeText(row?.name);
    if (name) {
      return name;
    }
  } catch {
    // ignore
  }

  return normalizePathBasename(root);
}

function mapRow(row: Record<string, unknown>): TaskNotificationRow {
  const taskId = normalizeText(row.task_id);
  const workspaceRoot = normalizeText(row.workspace_root);
  const projectId = normalizeText(row.project_id);
  const projectName = normalizeText(row.project_name);
  const taskTitle = normalizeText(row.task_title);
  const telegramChatId = normalizeText(row.telegram_chat_id);
  const status = normalizeText(row.status);
  const lastErrorRaw = normalizeText(row.last_error);

  return {
    taskId,
    workspaceRoot,
    projectId,
    projectName,
    taskTitle,
    telegramChatId,
    status,
    startedAt: parseOptionalTimestamp(row.started_at),
    completedAt: parseOptionalTimestamp(row.completed_at),
    createdAt: parseNonNegativeInteger(row.created_at),
    notifiedAt: parseOptionalTimestamp(row.notified_at, { positiveOnly: true }),
    lastError: lastErrorRaw || null,
    retryCount: parseNonNegativeInteger(row.retry_count),
    nextRetryAt: parseOptionalTimestamp(row.next_retry_at, { positiveOnly: true }),
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

  const now = resolveNow(args.now);
  const taskId = normalizeText(args.taskId);
  const workspaceRoot = normalizeText(args.workspaceRoot);
  const taskTitle = normalizeText(args.taskTitle);
  const projectId = deriveProjectSessionId(workspaceRoot);
  const projectName = resolveProjectNameAtCreate(db, args.authUserId, workspaceRoot);
  const telegram = resolveTaskNotificationTelegramConfigFromEnv();

  if (!taskId || !workspaceRoot) {
    return;
  }

  if (!telegram.ok) {
    args.logger?.warn?.(
      `[Web][TaskNotifications] Telegram config missing; set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID (single user; TELEGRAM_ALLOWED_USERS is legacy alias) to enable notifications taskId=${taskId}`,
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

  const now = resolveNow(args.now);
  const taskId = normalizeText(args.taskId);
  const workspaceRoot = normalizeText(args.workspaceRoot);
  const taskTitle = normalizeText(args.taskTitle) || "Task";
  const status = args.status;
  const completedAt = parseOptionalTimestamp(args.completedAt) ?? now;
  const startedAt = parseOptionalTimestamp(args.startedAt) ?? completedAt;
  const projectId = deriveProjectSessionId(workspaceRoot);
  const telegram = resolveTaskNotificationTelegramConfigFromEnv();

  if (!taskId || !workspaceRoot) {
    return;
  }

  if (!telegram.ok) {
    args.logger?.warn?.(
      `[Web][TaskNotifications] Telegram config missing; cannot notify terminal status (set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID with exactly one user ID; TELEGRAM_ALLOWED_USERS is legacy alias) taskId=${taskId} status=${status}`,
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

  const now = resolveNow(args.now);
  const limit = resolvePositiveInteger(args.limit, DEFAULT_LIST_LIMIT);
  const maxRetries = resolvePositiveInteger(args.maxRetries, DEFAULT_MAX_RETRIES);

  const rows = db
    .prepare(
      `
        SELECT task_id AS taskId
        FROM task_notifications
        WHERE notified_at IS NULL
          AND completed_at IS NOT NULL
          AND status IN (${TERMINAL_TASK_STATUSES_SQL})
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

  const now = resolveNow(args.now);
  const leaseMs = resolvePositiveInteger(args.leaseMs, DEFAULT_LEASE_MS);
  const maxRetries = resolvePositiveInteger(args.maxRetries, DEFAULT_MAX_RETRIES);

  const taskId = normalizeText(args.taskId);
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
          AND status IN (${TERMINAL_TASK_STATUSES_SQL})
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

  const taskId = normalizeText(args.taskId);
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

  const now = resolveNow(args.now);
  const taskId = normalizeText(args.taskId);
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

  const taskId = normalizeText(args.taskId);
  const error = normalizeText(args.error) || "unknown_error";
  const nextRetryAt = parseOptionalTimestamp(args.nextRetryAt);
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

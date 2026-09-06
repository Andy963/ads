import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../../state/database.js";
import { ensureWebAuthTables } from "../auth/schema.js";
import { ensureWebProjectTables } from "../projects/schema.js";
import { deriveProjectSessionId } from "../server/projectSessionId.js";

import { ensureTaskNotificationTables } from "./schema.js";

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

function resolveNow(now: unknown): number {
  const parsed = parseFiniteNumber(now);
  if (parsed == null) {
    return Date.now();
  }
  return Math.floor(parsed);
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

export function upsertTaskNotificationBinding(args: {
  db?: DatabaseType;
  authUserId: string;
  workspaceRoot: string;
  taskId: string;
  taskTitle: string;
  telegramChatId?: string | null;
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
  const deliveryTargetId = normalizeText(args.telegramChatId);

  if (!taskId || !workspaceRoot) {
    return;
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
    deliveryTargetId,
    now,
    null,
  );
}

import crypto from "node:crypto";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../../../state/database.js";
import { taskBundleSchema, type TaskBundle } from "./taskBundle.js";

type SqliteStatement = StatementType<unknown[], unknown>;

export type TaskBundleDraftStatus = "draft" | "approved" | "deleted";

export type TaskBundleDraft = {
  id: string;
  workspaceRoot: string;
  requestId: string | null;
  status: TaskBundleDraftStatus;
  bundle: TaskBundle | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  approvedTaskIds: string[];
  lastError: string | null;
};

function normalizeStatus(status: unknown): TaskBundleDraftStatus {
  const raw = String(status ?? "").trim().toLowerCase();
  if (raw === "approved") return "approved";
  if (raw === "deleted") return "deleted";
  return "draft";
}

function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function parseApprovedTaskIds(raw: unknown): string[] {
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((id) => String(id ?? "").trim()).filter(Boolean);
}

function mapRow(row: Record<string, unknown>): TaskBundleDraft {
  const id = String(row.draft_id ?? "").trim();
  const workspaceRoot = String(row.workspace_root ?? "").trim();
  const requestId = (() => {
    const value = String(row.request_id ?? "").trim();
    return value ? value : null;
  })();
  const status = normalizeStatus(row.status);
  const createdAt = typeof row.created_at === "number" && Number.isFinite(row.created_at) ? row.created_at : 0;
  const updatedAt = typeof row.updated_at === "number" && Number.isFinite(row.updated_at) ? row.updated_at : createdAt;
  const approvedAt =
    typeof row.approved_at === "number" && Number.isFinite(row.approved_at) && row.approved_at > 0
      ? row.approved_at
      : null;
  const lastError = (() => {
    const value = String(row.last_error ?? "").trim();
    return value ? value : null;
  })();

  const approvedTaskIds = parseApprovedTaskIds(row.approved_task_ids_json);

  const parsedBundle = safeJsonParse(row.bundle_json);
  const bundle = (() => {
    if (!parsedBundle) return null;
    const result = taskBundleSchema.safeParse(parsedBundle);
    return result.success ? result.data : null;
  })();

  return {
    id,
    workspaceRoot,
    requestId,
    status,
    bundle,
    createdAt,
    updatedAt,
    approvedAt,
    approvedTaskIds,
    lastError,
  };
}

function prepareStatements(db: DatabaseType) {
  const insertStmt: SqliteStatement = db.prepare(
    `INSERT INTO web_task_bundle_drafts (
        draft_id,
        namespace,
        auth_user_id,
        workspace_root,
        request_id,
        source_chat_session_id,
        source_history_key,
        bundle_json,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const updateByRequestIdStmt: SqliteStatement = db.prepare(
    `UPDATE web_task_bundle_drafts
     SET bundle_json = ?, status = 'draft', updated_at = ?, source_history_key = ?, last_error = NULL
     WHERE namespace = ? AND auth_user_id = ? AND workspace_root = ? AND request_id = ? AND status = 'draft'`,
  );

  const selectByRequestIdStmt: SqliteStatement = db.prepare(
    `SELECT *
     FROM web_task_bundle_drafts
     WHERE namespace = ? AND auth_user_id = ? AND workspace_root = ? AND request_id = ?
     LIMIT 1`,
  );

  const selectByIdStmt: SqliteStatement = db.prepare(
    `SELECT *
     FROM web_task_bundle_drafts
     WHERE namespace = ? AND auth_user_id = ? AND draft_id = ?
     LIMIT 1`,
  );

  const listStmt: SqliteStatement = db.prepare(
    `SELECT *
     FROM web_task_bundle_drafts
     WHERE namespace = ? AND auth_user_id = ? AND workspace_root = ? AND status != 'deleted'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT ?`,
  );

  const deleteStmt: SqliteStatement = db.prepare(
    `UPDATE web_task_bundle_drafts
     SET status = 'deleted', updated_at = ?
     WHERE namespace = ? AND auth_user_id = ? AND draft_id = ? AND status != 'deleted'`,
  );

  const updateDraftStmt: SqliteStatement = db.prepare(
    `UPDATE web_task_bundle_drafts
     SET bundle_json = ?, updated_at = ?, last_error = NULL
     WHERE namespace = ? AND auth_user_id = ? AND draft_id = ? AND status = 'draft'`,
  );

  const approveStmt: SqliteStatement = db.prepare(
    `UPDATE web_task_bundle_drafts
     SET status = 'approved', approved_at = ?, approved_task_ids_json = ?, updated_at = ?, last_error = NULL
     WHERE namespace = ? AND auth_user_id = ? AND draft_id = ? AND status = 'draft'`,
  );

  const setErrorStmt: SqliteStatement = db.prepare(
    `UPDATE web_task_bundle_drafts
     SET last_error = ?, updated_at = ?
     WHERE namespace = ? AND auth_user_id = ? AND draft_id = ?`,
  );

  return {
    insertStmt,
    updateByRequestIdStmt,
    selectByRequestIdStmt,
    selectByIdStmt,
    listStmt,
    deleteStmt,
    updateDraftStmt,
    approveStmt,
    setErrorStmt,
  };
}

export function upsertTaskBundleDraft(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  workspaceRoot: string;
  sourceChatSessionId: string;
  sourceHistoryKey?: string | null;
  bundle: TaskBundle;
  now?: number;
}): TaskBundleDraft {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const sourceChatSessionId = String(args.sourceChatSessionId ?? "").trim();
  const sourceHistoryKey = args.sourceHistoryKey == null ? null : String(args.sourceHistoryKey ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();

  if (!authUserId) {
    throw new Error("authUserId is required");
  }
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is required");
  }
  if (!sourceChatSessionId) {
    throw new Error("sourceChatSessionId is required");
  }

  const stmts = prepareStatements(db);
  const requestId = String(args.bundle.requestId ?? "").trim();
  const bundleJson = JSON.stringify(args.bundle);

  if (requestId) {
    const existing = stmts.selectByRequestIdStmt.get(namespace, authUserId, workspaceRoot, requestId) as Record<string, unknown> | undefined;
    if (existing && String(existing.draft_id ?? "").trim()) {
      stmts.updateByRequestIdStmt.run(bundleJson, now, sourceHistoryKey, namespace, authUserId, workspaceRoot, requestId);
      const reread = stmts.selectByRequestIdStmt.get(namespace, authUserId, workspaceRoot, requestId) as Record<string, unknown> | undefined;
      if (reread) {
        return mapRow(reread);
      }
    }
  }

  const draftId = crypto.randomUUID();
  stmts.insertStmt.run(
    draftId,
    namespace,
    authUserId,
    workspaceRoot,
    requestId || null,
    sourceChatSessionId,
    sourceHistoryKey,
    bundleJson,
    "draft",
    now,
    now,
  );

  const row = stmts.selectByIdStmt.get(namespace, authUserId, draftId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Failed to read inserted draft");
  }
  return mapRow(row);
}

export function listTaskBundleDrafts(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  workspaceRoot: string;
  limit?: number;
}): TaskBundleDraft[] {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 50;

  if (!authUserId || !workspaceRoot) {
    return [];
  }

  const stmts = prepareStatements(db);
  const rows = stmts.listStmt.all(namespace, authUserId, workspaceRoot, limit) as Record<string, unknown>[];
  return rows.map((row) => mapRow(row)).filter((draft) => draft.id && draft.workspaceRoot);
}

export function getTaskBundleDraft(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  draftId: string;
}): TaskBundleDraft | null {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  if (!authUserId || !draftId) return null;

  const stmts = prepareStatements(db);
  const row = stmts.selectByIdStmt.get(namespace, authUserId, draftId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function deleteTaskBundleDraft(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  draftId: string;
  now?: number;
}): { ok: boolean } {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  if (!authUserId || !draftId) return { ok: false };

  const stmts = prepareStatements(db);
  const res = stmts.deleteStmt.run(now, namespace, authUserId, draftId) as { changes?: number };
  return { ok: Boolean(res && res.changes && res.changes > 0) };
}

export function updateTaskBundleDraft(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  draftId: string;
  bundle: TaskBundle;
  now?: number;
}): TaskBundleDraft | null {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  if (!authUserId || !draftId) return null;

  const stmts = prepareStatements(db);
  const bundleJson = JSON.stringify(args.bundle);
  const res = stmts.updateDraftStmt.run(bundleJson, now, namespace, authUserId, draftId) as { changes?: number };
  if (!res || res.changes !== 1) {
    return null;
  }
  return getTaskBundleDraft({ db, namespace, authUserId, draftId });
}

export function approveTaskBundleDraft(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  draftId: string;
  approvedTaskIds: string[];
  now?: number;
}): TaskBundleDraft | null {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  if (!authUserId || !draftId) return null;

  const stmts = prepareStatements(db);
  const approvedJson = JSON.stringify((args.approvedTaskIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean));
  const res = stmts.approveStmt.run(now, approvedJson, now, namespace, authUserId, draftId) as { changes?: number };
  if (!res || res.changes !== 1) {
    return null;
  }
  return getTaskBundleDraft({ db, namespace, authUserId, draftId });
}

export function setTaskBundleDraftError(args: {
  db?: DatabaseType;
  namespace?: string;
  authUserId: string;
  draftId: string;
  error: string;
  now?: number;
}): void {
  const db = args.db ?? getStateDatabase();
  const namespace = String(args.namespace ?? "web").trim() || "web";
  const authUserId = String(args.authUserId ?? "").trim();
  const draftId = String(args.draftId ?? "").trim();
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? Math.floor(args.now) : Date.now();
  if (!authUserId || !draftId) return;

  const stmts = prepareStatements(db);
  stmts.setErrorStmt.run(String(args.error ?? "").trim(), now, namespace, authUserId, draftId);
}

import path from "node:path";

import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import { getStateDatabase, resolveStateDbPath } from "../../state/database.js";

import type { TaskResult, TaskSpec } from "./schemas.js";

type SqliteStatement = StatementType<unknown[], unknown>;

export type TaskStatus =
  | "PENDING"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "ACCEPTED"
  | "REJECTED"
  | "REWORK"
  | "DONE"
  | "FAILED"
  | "NEEDS_CLARIFICATION";

export interface TaskRow {
  taskId: string;
  parentTaskId?: string;
  namespace: string;
  sessionId: string;
  agentId: string;
  revision: number;
  status: TaskStatus;
  spec: TaskSpec;
  result?: TaskResult;
  verification?: unknown;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

function normalizeStatus(value: unknown): TaskStatus {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  switch (raw) {
    case "PENDING":
    case "ASSIGNED":
    case "IN_PROGRESS":
    case "SUBMITTED":
    case "ACCEPTED":
    case "REJECTED":
    case "REWORK":
    case "DONE":
    case "FAILED":
    case "NEEDS_CLARIFICATION":
      return raw;
    default:
      return "PENDING";
  }
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return undefined;
  }
}

export class TaskStore {
  private readonly db: DatabaseType;
  private readonly namespace: string;
  private readonly sessionId: string;

  private readonly upsertTaskStmt: SqliteStatement;
  private readonly updateStatusStmt: SqliteStatement;
  private readonly updateResultStmt: SqliteStatement;
  private readonly updateVerificationStmt: SqliteStatement;
  private readonly incrementAttemptsStmt: SqliteStatement;
  private readonly appendMessageStmt: SqliteStatement;
  private readonly listTasksStmt: SqliteStatement;
  private readonly listActiveTasksStmt: SqliteStatement;
  private readonly getTaskByIdStmt: SqliteStatement;
  private readonly clearOutputsStmt: SqliteStatement;

  constructor(options: { workspaceRoot: string; namespace: string; sessionId: string; dbPath?: string }) {
    this.namespace = String(options.namespace ?? "").trim() || "default";
    this.sessionId = String(options.sessionId ?? "").trim() || "default";

    const resolvedDbPath = resolveStateDbPath(
      options.dbPath ?? path.join(path.resolve(options.workspaceRoot), ".ads", "state.db"),
    );
    this.db = getStateDatabase(resolvedDbPath);

    this.upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (
        task_id,
        parent_task_id,
        namespace,
        session_id,
        agent_id,
        revision,
        status,
        spec_json,
        attempts,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        parent_task_id = excluded.parent_task_id,
        agent_id = excluded.agent_id,
        revision = excluded.revision,
        status = excluded.status,
        spec_json = excluded.spec_json,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `);

    this.updateStatusStmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, last_error = ?, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND task_id = ?
    `);

    this.updateResultStmt = this.db.prepare(`
      UPDATE tasks
      SET result_json = ?, status = ?, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND task_id = ?
    `);

    this.updateVerificationStmt = this.db.prepare(`
      UPDATE tasks
      SET verification_json = ?, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND task_id = ?
    `);

    this.clearOutputsStmt = this.db.prepare(`
      UPDATE tasks
      SET result_json = NULL, verification_json = NULL, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND task_id = ?
    `);

    this.incrementAttemptsStmt = this.db.prepare(`
      UPDATE tasks
      SET attempts = attempts + 1, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND task_id = ?
    `);

    this.appendMessageStmt = this.db.prepare(`
      INSERT INTO task_messages (task_id, namespace, session_id, role, kind, payload, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.listTasksStmt = this.db.prepare(`
      SELECT *
      FROM tasks
      WHERE namespace = ? AND session_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `);

    this.listActiveTasksStmt = this.db.prepare(`
      SELECT *
      FROM tasks
      WHERE namespace = ? AND session_id = ?
        AND status NOT IN ('DONE', 'FAILED')
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `);

    this.getTaskByIdStmt = this.db.prepare(`
      SELECT *
      FROM tasks
      WHERE namespace = ? AND session_id = ? AND task_id = ?
      LIMIT 1
    `);
  }

  upsertTask(spec: TaskSpec, status: TaskStatus, now = Date.now(), options?: { lastError?: string | null; parentTaskId?: string | null }): void {
    const parentTaskId =
      options?.parentTaskId !== undefined
        ? options.parentTaskId
        : spec.parentTaskId ?? null;
    const lastError =
      options?.lastError !== undefined ? options.lastError : null;

    const serializedSpec = JSON.stringify(spec);
    this.upsertTaskStmt.run(
      spec.taskId,
      parentTaskId,
      this.namespace,
      this.sessionId,
      spec.agentId,
      spec.revision,
      status,
      serializedSpec,
      0,
      lastError,
      now,
      now,
    );
  }

  updateStatus(taskId: string, status: TaskStatus, now = Date.now(), lastError?: string | null): void {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return;
    }
    this.updateStatusStmt.run(
      status,
      lastError ?? null,
      now,
      this.namespace,
      this.sessionId,
      normalizedId,
    );
  }

  incrementAttempts(taskId: string, now = Date.now()): void {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return;
    }
    this.incrementAttemptsStmt.run(now, this.namespace, this.sessionId, normalizedId);
  }

  setResult(taskId: string, result: TaskResult, status: TaskStatus, now = Date.now()): void {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return;
    }
    this.updateResultStmt.run(
      JSON.stringify(result),
      status,
      now,
      this.namespace,
      this.sessionId,
      normalizedId,
    );
  }

  setVerification(taskId: string, verification: unknown, now = Date.now()): void {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return;
    }
    this.updateVerificationStmt.run(
      JSON.stringify(verification ?? null),
      now,
      this.namespace,
      this.sessionId,
      normalizedId,
    );
  }

  clearOutputs(taskId: string, now = Date.now()): void {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return;
    }
    this.clearOutputsStmt.run(now, this.namespace, this.sessionId, normalizedId);
  }

  appendMessage(taskId: string, entry: { role: string; kind?: string; payload?: unknown }, now = Date.now()): void {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return;
    }
    const role = String(entry.role ?? "").trim() || "system";
    const kind = entry.kind ? String(entry.kind).trim() : null;
    const payload =
      entry.payload === undefined
        ? null
        : typeof entry.payload === "string"
          ? entry.payload
          : JSON.stringify(entry.payload);
    this.appendMessageStmt.run(
      normalizedId,
      this.namespace,
      this.sessionId,
      role,
      kind,
      payload,
      now,
    );
  }

  getTask(taskId: string): TaskRow | null {
    const normalizedId = String(taskId ?? "").trim();
    if (!normalizedId) {
      return null;
    }
    const row = this.getTaskByIdStmt.get(this.namespace, this.sessionId, normalizedId) as Record<string, unknown> | undefined;
    return row ? this.toTaskRow(row) : null;
  }

  listTasks(options?: { limit?: number; activeOnly?: boolean }): TaskRow[] {
    const limit = typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;
    const stmt = options?.activeOnly ? this.listActiveTasksStmt : this.listTasksStmt;
    const rows = stmt.all(this.namespace, this.sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.toTaskRow(row));
  }

  private toTaskRow(row: Record<string, unknown>): TaskRow {
    const spec = parseJson<TaskSpec>(row.spec_json) ?? ({} as TaskSpec);
    const result = parseJson<TaskResult>(row.result_json);
    const verification = parseJson<unknown>(row.verification_json);
    return {
      taskId: String(row.task_id ?? ""),
      parentTaskId: typeof row.parent_task_id === "string" && row.parent_task_id.trim() ? row.parent_task_id.trim() : undefined,
      namespace: String(row.namespace ?? ""),
      sessionId: String(row.session_id ?? ""),
      agentId: String(row.agent_id ?? ""),
      revision: typeof row.revision === "number" ? row.revision : Number(row.revision ?? 0),
      status: normalizeStatus(row.status),
      spec,
      result,
      verification,
      attempts: typeof row.attempts === "number" ? row.attempts : Number(row.attempts ?? 0),
      lastError: typeof row.last_error === "string" && row.last_error.trim() ? row.last_error.trim() : undefined,
      createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at ?? 0),
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at ?? 0),
    };
  }
}

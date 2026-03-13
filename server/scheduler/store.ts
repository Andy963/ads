import crypto from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";
import { parseOptionalSqliteInt, parseSqliteBoolean } from "../utils/sqlite.js";

import { ScheduleSpecSchema, type ScheduleSpec } from "./scheduleSpec.js";

export type StoredSchedule = {
  id: string;
  instruction: string;
  spec: ScheduleSpec;
  enabled: boolean;
  nextRunAt: number | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ScheduleRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type StoredScheduleRun = {
  id: number;
  scheduleId: string;
  externalId: string;
  runAt: number;
  status: ScheduleRunStatus;
  taskId: string | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
};

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_RECONCILE_LIMIT = 200;
const SCHEDULE_RUN_STATUSES: readonly ScheduleRunStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

function normalizeTrimmedString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeOptionalTrimmedString(value: unknown): string | null {
  const normalized = normalizeTrimmedString(value);
  return normalized || null;
}

function normalizePositiveLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseScheduleRunStatus(value: unknown): ScheduleRunStatus {
  const raw = normalizeTrimmedString(value);
  return SCHEDULE_RUN_STATUSES.includes(raw as ScheduleRunStatus) ? (raw as ScheduleRunStatus) : "queued";
}

function mapTaskStatusToRunStatus(value: unknown): ScheduleRunStatus | null {
  switch (normalizeTrimmedString(value)) {
    case "planning":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

function parseScheduleRow(row: Record<string, unknown>): StoredSchedule {
  const id = normalizeTrimmedString(row.id);
  if (!id) {
    throw new Error("Schedule row missing id");
  }
  const instruction = String(row.instruction ?? "");
  const specRaw = String(row.spec_json ?? "");
  let specJson: unknown;
  try {
    specJson = JSON.parse(specRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid schedule spec_json (id=${id}): ${message}`);
  }
  const specParsed = ScheduleSpecSchema.safeParse(specJson);
  if (!specParsed.success) {
    throw new Error(`Invalid schedule spec schema (id=${id})`);
  }
  return {
    id,
    instruction,
    spec: specParsed.data,
    enabled: parseSqliteBoolean(row.enabled),
    nextRunAt: parseOptionalSqliteInt(row.next_run_at),
    leaseOwner: normalizeOptionalTrimmedString(row.lease_owner),
    leaseUntil: parseOptionalSqliteInt(row.lease_until),
    createdAt: parseOptionalSqliteInt(row.created_at) ?? 0,
    updatedAt: parseOptionalSqliteInt(row.updated_at) ?? 0,
  };
}

function parseScheduleRunRow(row: Record<string, unknown>): StoredScheduleRun {
  const id = parseOptionalSqliteInt(row.id);
  if (id == null) {
    throw new Error("Schedule run row missing id");
  }
  const scheduleId = normalizeTrimmedString(row.schedule_id);
  const externalId = normalizeTrimmedString(row.external_id);
  const runAt = parseOptionalSqliteInt(row.run_at) ?? 0;

  return {
    id,
    scheduleId,
    externalId,
    runAt,
    status: parseScheduleRunStatus(row.status),
    taskId: normalizeOptionalTrimmedString(row.task_id),
    result: row.result == null ? null : String(row.result ?? ""),
    error: row.error == null ? null : String(row.error ?? ""),
    createdAt: parseOptionalSqliteInt(row.created_at) ?? 0,
    startedAt: parseOptionalSqliteInt(row.started_at),
    completedAt: parseOptionalSqliteInt(row.completed_at),
    updatedAt: parseOptionalSqliteInt(row.updated_at) ?? 0,
  };
}

export class ScheduleStore {
  private readonly db: DatabaseType;

  constructor(options?: { workspacePath?: string }) {
    this.db = getDatabase(options?.workspacePath);
  }

  createSchedule(input: { instruction: string; spec: ScheduleSpec; enabled: boolean; nextRunAt: number | null }, now = Date.now()): StoredSchedule {
    const id = crypto.randomUUID();
    const instruction = String(input.instruction ?? "");
    const specJson = JSON.stringify(input.spec);
    const enabled = input.enabled ? 1 : 0;
    const nextRunAt = input.nextRunAt == null ? null : Math.floor(input.nextRunAt);

    this.db
      .prepare(
        `INSERT INTO schedules (
          id, instruction, spec_json, enabled, next_run_at,
          lease_owner, lease_until,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, instruction, specJson, enabled, nextRunAt, now, now);

    const created = this.getSchedule(id);
    if (!created) {
      throw new Error("Failed to read back created schedule");
    }
    return created;
  }

  getSchedule(id: string): StoredSchedule | null {
    const scheduleId = normalizeTrimmedString(id);
    if (!scheduleId) return null;
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ? LIMIT 1`).get(scheduleId) as
      | Record<string, unknown>
      | undefined;
    return row ? parseScheduleRow(row) : null;
  }

  listSchedules(options?: { limit?: number }): StoredSchedule[] {
    const limit = normalizePositiveLimit(options?.limit, DEFAULT_LIST_LIMIT);
    const rows = this.db
      .prepare(`SELECT * FROM schedules ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => parseScheduleRow(row));
  }

  updateSchedule(
    id: string,
    updates: Partial<{ instruction: string; spec: ScheduleSpec; enabled: boolean; nextRunAt: number | null; leaseOwner: string | null; leaseUntil: number | null }>,
    now = Date.now(),
  ): StoredSchedule {
    const scheduleId = normalizeTrimmedString(id);
    if (!scheduleId) {
      throw new Error("Schedule id is required");
    }
    const existing = this.getSchedule(scheduleId);
    if (!existing) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const instruction = updates.instruction !== undefined ? String(updates.instruction) : existing.instruction;
    const spec = updates.spec !== undefined ? updates.spec : existing.spec;
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
    const nextRunAt =
      updates.nextRunAt !== undefined ? (updates.nextRunAt == null ? null : Math.floor(updates.nextRunAt)) : existing.nextRunAt;
    const leaseOwner =
      updates.leaseOwner !== undefined ? normalizeOptionalTrimmedString(updates.leaseOwner) : existing.leaseOwner;
    const leaseUntil =
      updates.leaseUntil !== undefined ? (updates.leaseUntil == null ? null : Math.floor(updates.leaseUntil)) : existing.leaseUntil;

    this.db
      .prepare(
        `UPDATE schedules
         SET instruction = ?, spec_json = ?, enabled = ?, next_run_at = ?, lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(instruction, JSON.stringify(spec), enabled, nextRunAt, leaseOwner, leaseUntil, now, scheduleId);

    const updated = this.getSchedule(scheduleId);
    if (!updated) {
      throw new Error("Failed to read back updated schedule");
    }
    return updated;
  }

  listDueScheduleIds(nowMs: number, options?: { limit?: number }): string[] {
    const now = Math.floor(nowMs);
    const limit = normalizePositiveLimit(options?.limit, DEFAULT_LIST_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT id
         FROM schedules
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
           AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY next_run_at ASC, id ASC
         LIMIT ?`,
      )
      .all(now, now, limit) as Array<{ id?: unknown }>;
    return rows.map((r) => normalizeTrimmedString(r.id)).filter(Boolean);
  }

  claimScheduleLease(options: { scheduleId: string; leaseOwner: string; leaseUntil: number; nowMs: number }): boolean {
    const scheduleId = normalizeTrimmedString(options.scheduleId);
    const owner = normalizeTrimmedString(options.leaseOwner);
    if (!scheduleId || !owner) return false;
    const now = Math.floor(options.nowMs);
    const until = Math.floor(options.leaseUntil);
    const result = this.db
      .prepare(
        `UPDATE schedules
         SET lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE id = ?
           AND enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
           AND (lease_until IS NULL OR lease_until <= ?)`,
      )
      .run(owner, until, now, scheduleId, now, now) as { changes?: number };
    return Boolean(result && result.changes === 1);
  }

  releaseScheduleLease(options: { scheduleId: string; leaseOwner: string | null }, now = Date.now()): void {
    const scheduleId = normalizeTrimmedString(options.scheduleId);
    if (!scheduleId) return;
    const owner = normalizeOptionalTrimmedString(options.leaseOwner);
    if (!owner) {
      this.db.prepare(`UPDATE schedules SET lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).run(now, scheduleId);
      return;
    }
    this.db
      .prepare(`UPDATE schedules SET lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?`)
      .run(now, scheduleId, owner);
  }

  insertRun(
    input: { scheduleId: string; externalId: string; runAt: number; taskId: string | null; status: ScheduleRunStatus },
    now = Date.now(),
  ): { inserted: boolean; runId: number | null } {
    const scheduleId = normalizeTrimmedString(input.scheduleId);
    const externalId = normalizeTrimmedString(input.externalId);
    if (!scheduleId || !externalId) {
      throw new Error("scheduleId and externalId are required");
    }
    const runAt = Math.floor(input.runAt);
    const taskId = normalizeOptionalTrimmedString(input.taskId);
    const status = input.status;

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO schedule_runs (
        schedule_id, external_id, run_at, status, task_id,
        result, error,
        created_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)`,
    );

    const result = stmt.run(scheduleId, externalId, runAt, status, taskId, now, now) as { changes?: number; lastInsertRowid?: unknown };
    const inserted = Boolean(result && result.changes === 1);
    const runId = inserted ? Number(result.lastInsertRowid ?? 0) : null;
    return { inserted, runId: inserted && Number.isFinite(runId) ? runId : null };
  }

  getRunByExternalId(externalId: string): StoredScheduleRun | null {
    const id = normalizeTrimmedString(externalId);
    if (!id) return null;
    const row = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE external_id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? parseScheduleRunRow(row) : null;
  }

  updateRunByExternalId(
    externalId: string,
    updates: Partial<{
      status: ScheduleRunStatus;
      taskId: string | null;
      result: string | null;
      error: string | null;
      startedAt: number | null;
      completedAt: number | null;
    }>,
    now = Date.now(),
  ): StoredScheduleRun {
    const id = normalizeTrimmedString(externalId);
    if (!id) {
      throw new Error("externalId is required");
    }
    const existing = this.getRunByExternalId(id);
    if (!existing) {
      throw new Error(`Schedule run not found: ${id}`);
    }

    const status = updates.status ?? existing.status;
    const taskId = updates.taskId !== undefined ? updates.taskId : existing.taskId;
    const result = updates.result !== undefined ? updates.result : existing.result;
    const error = updates.error !== undefined ? updates.error : existing.error;
    const startedAt = updates.startedAt !== undefined ? updates.startedAt : existing.startedAt;
    const completedAt = updates.completedAt !== undefined ? updates.completedAt : existing.completedAt;

    this.db
      .prepare(
        `UPDATE schedule_runs
         SET status = ?, task_id = ?, result = ?, error = ?, started_at = ?, completed_at = ?, updated_at = ?
         WHERE external_id = ?`,
      )
      .run(status, taskId, result, error, startedAt, completedAt, now, id);

    const updated = this.getRunByExternalId(id);
    if (!updated) {
      throw new Error("Failed to read back updated schedule run");
    }
    return updated;
  }

  listRuns(scheduleId: string, options?: { limit?: number }): StoredScheduleRun[] {
    const id = normalizeTrimmedString(scheduleId);
    if (!id) return [];
    const limit = normalizePositiveLimit(options?.limit, DEFAULT_LIST_LIMIT);
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY run_at DESC, id DESC LIMIT ?`)
      .all(id, limit) as Record<string, unknown>[];
    return rows.map((r) => parseScheduleRunRow(r));
  }

  reconcileRuns(options?: { limit?: number; nowMs?: number }): number {
    const limit = normalizePositiveLimit(options?.limit, DEFAULT_RECONCILE_LIMIT);
    const now = typeof options?.nowMs === "number" && Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();

    const rows = this.db
      .prepare(
        `SELECT r.external_id AS external_id, r.task_id AS task_id, r.status AS status
         FROM schedule_runs r
         WHERE r.status IN ('queued', 'running')
         ORDER BY r.run_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ external_id?: unknown; task_id?: unknown; status?: unknown }>;

    let updated = 0;

    const taskStmt = this.db.prepare(`SELECT status, result, error, started_at, completed_at FROM tasks WHERE id = ? LIMIT 1`);

    for (const row of rows) {
      const externalId = normalizeTrimmedString(row.external_id);
      const taskId = normalizeTrimmedString(row.task_id);
      if (!externalId || !taskId) {
        continue;
      }
      const task = taskStmt.get(taskId) as
        | { status?: unknown; result?: unknown; error?: unknown; started_at?: unknown; completed_at?: unknown }
        | undefined;
      if (!task) {
        continue;
      }

      const startedAt = parseOptionalSqliteInt(task.started_at);
      const completedAt = parseOptionalSqliteInt(task.completed_at);
      const result = task.result == null ? null : String(task.result ?? "");
      const error = task.error == null ? null : String(task.error ?? "");
      const nextStatus = mapTaskStatusToRunStatus(task.status);
      if (!nextStatus) {
        continue;
      }

      const desiredStartedAt = nextStatus === "running" || startedAt != null ? startedAt ?? now : startedAt;
      const desiredCompletedAt =
        nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled"
          ? completedAt ?? now
          : null;

      try {
        this.updateRunByExternalId(
          externalId,
          {
            status: nextStatus,
            startedAt: desiredStartedAt ?? null,
            completedAt: desiredCompletedAt,
            result,
            error,
          },
          now,
        );
        updated += 1;
      } catch {
        // ignore
      }
    }

    return updated;
  }
}

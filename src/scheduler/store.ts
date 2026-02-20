import crypto from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";

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

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return false;
}

function parseOptionalInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScheduleRow(row: Record<string, unknown>): StoredSchedule {
  const id = String(row.id ?? "").trim();
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
    enabled: parseBooleanFlag(row.enabled),
    nextRunAt: parseOptionalInt(row.next_run_at),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner ?? "").trim() || null,
    leaseUntil: parseOptionalInt(row.lease_until),
    createdAt: parseOptionalInt(row.created_at) ?? 0,
    updatedAt: parseOptionalInt(row.updated_at) ?? 0,
  };
}

function parseScheduleRunRow(row: Record<string, unknown>): StoredScheduleRun {
  const id = parseOptionalInt(row.id);
  if (id == null) {
    throw new Error("Schedule run row missing id");
  }
  const scheduleId = String(row.schedule_id ?? "").trim();
  const externalId = String(row.external_id ?? "").trim();
  const runAt = parseOptionalInt(row.run_at) ?? 0;
  const statusRaw = String(row.status ?? "").trim();
  const status = (["queued", "running", "completed", "failed", "cancelled"].includes(statusRaw)
    ? statusRaw
    : "queued") as ScheduleRunStatus;

  return {
    id,
    scheduleId,
    externalId,
    runAt,
    status,
    taskId: row.task_id == null ? null : String(row.task_id ?? "").trim() || null,
    result: row.result == null ? null : String(row.result ?? ""),
    error: row.error == null ? null : String(row.error ?? ""),
    createdAt: parseOptionalInt(row.created_at) ?? 0,
    startedAt: parseOptionalInt(row.started_at),
    completedAt: parseOptionalInt(row.completed_at),
    updatedAt: parseOptionalInt(row.updated_at) ?? 0,
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
    const scheduleId = String(id ?? "").trim();
    if (!scheduleId) return null;
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ? LIMIT 1`).get(scheduleId) as
      | Record<string, unknown>
      | undefined;
    return row ? parseScheduleRow(row) : null;
  }

  listSchedules(options?: { limit?: number }): StoredSchedule[] {
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 50;
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
    const scheduleId = String(id ?? "").trim();
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
      updates.leaseOwner !== undefined ? (updates.leaseOwner == null ? null : String(updates.leaseOwner).trim() || null) : existing.leaseOwner;
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
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 50;
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
    return rows.map((r) => String(r.id ?? "").trim()).filter(Boolean);
  }

  claimScheduleLease(options: { scheduleId: string; leaseOwner: string; leaseUntil: number; nowMs: number }): boolean {
    const scheduleId = String(options.scheduleId ?? "").trim();
    const owner = String(options.leaseOwner ?? "").trim();
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
    const scheduleId = String(options.scheduleId ?? "").trim();
    if (!scheduleId) return;
    const owner = options.leaseOwner == null ? null : String(options.leaseOwner).trim();
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
    const scheduleId = String(input.scheduleId ?? "").trim();
    const externalId = String(input.externalId ?? "").trim();
    if (!scheduleId || !externalId) {
      throw new Error("scheduleId and externalId are required");
    }
    const runAt = Math.floor(input.runAt);
    const taskId = input.taskId == null ? null : String(input.taskId).trim() || null;
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
    const id = String(externalId ?? "").trim();
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
    const id = String(externalId ?? "").trim();
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
    const id = String(scheduleId ?? "").trim();
    if (!id) return [];
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 50;
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY run_at DESC, id DESC LIMIT ?`)
      .all(id, limit) as Record<string, unknown>[];
    return rows.map((r) => parseScheduleRunRow(r));
  }

  reconcileRuns(options?: { limit?: number; nowMs?: number }): number {
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;
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
      const externalId = String(row.external_id ?? "").trim();
      const taskId = String(row.task_id ?? "").trim();
      if (!externalId || !taskId) {
        continue;
      }
      const task = taskStmt.get(taskId) as
        | { status?: unknown; result?: unknown; error?: unknown; started_at?: unknown; completed_at?: unknown }
        | undefined;
      if (!task) {
        continue;
      }

      const taskStatus = String(task.status ?? "").trim();
      const startedAt = parseOptionalInt(task.started_at);
      const completedAt = parseOptionalInt(task.completed_at);
      const result = task.result == null ? null : String(task.result ?? "");
      const error = task.error == null ? null : String(task.error ?? "");

      const nextStatus: ScheduleRunStatus | null = (() => {
        if (taskStatus === "running" || taskStatus === "planning") return "running";
        if (taskStatus === "completed") return "completed";
        if (taskStatus === "failed") return "failed";
        if (taskStatus === "cancelled") return "cancelled";
        return null;
      })();
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


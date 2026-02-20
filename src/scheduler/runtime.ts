import crypto from "node:crypto";

import { TaskStore } from "../tasks/store.js";

import { computeNextCronRunAt } from "./cron.js";
import { ScheduleStore } from "./store.js";
import type { StoredSchedule } from "./store.js";

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function renderIdempotencyKey(template: string, scheduleId: string, runAtIso: string): string {
  const t = String(template ?? "").trim();
  if (!t) {
    return `sch:${scheduleId}:${runAtIso}`;
  }
  const replaced = t.replaceAll("{scheduleId}", scheduleId).replaceAll("{runAtIso}", runAtIso);
  return replaced || `sch:${scheduleId}:${runAtIso}`;
}

function buildExternalId(schedule: StoredSchedule, runAtMs: number): string {
  const runAtIso = new Date(runAtMs).toISOString();
  return renderIdempotencyKey(schedule.spec.policy.idempotencyKeyTemplate, schedule.id, runAtIso);
}

export class SchedulerRuntime {
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private readonly leaseTtlMs: number;
  private readonly dueLimit: number;
  private readonly reconcileLimit: number;
  private readonly ownerId: string;

  private interval: NodeJS.Timeout | null = null;
  private readonly workspaces = new Set<string>();
  private readonly stores = new Map<string, ScheduleStore>();
  private readonly taskStores = new Map<string, TaskStore>();
  private readonly inFlight = new Set<string>();

  constructor(options?: {
    enabled?: boolean;
    tickMs?: number;
    leaseTtlMs?: number;
    dueLimit?: number;
    reconcileLimit?: number;
    ownerId?: string;
  }) {
    this.enabled = options?.enabled ?? parseBooleanEnv(process.env.ADS_SCHEDULER_ENABLED, true);
    this.tickMs = options?.tickMs ?? parsePositiveInt(process.env.ADS_SCHEDULER_TICK_MS, 5000);
    this.leaseTtlMs = options?.leaseTtlMs ?? parsePositiveInt(process.env.ADS_SCHEDULER_LEASE_TTL_MS, 30_000);
    this.dueLimit = options?.dueLimit ?? parsePositiveInt(process.env.ADS_SCHEDULER_DUE_LIMIT, 20);
    this.reconcileLimit = options?.reconcileLimit ?? parsePositiveInt(process.env.ADS_SCHEDULER_RECONCILE_LIMIT, 200);
    this.ownerId = options?.ownerId ?? crypto.randomUUID();
  }

  registerWorkspace(workspaceRoot: string): void {
    const normalized = String(workspaceRoot ?? "").trim();
    if (!normalized) return;
    this.workspaces.add(normalized);
    // Ensure db schema exists eagerly.
    this.getStore(normalized);
  }

  start(): void {
    if (!this.enabled) {
      return;
    }
    if (this.interval) {
      return;
    }
    this.interval = setInterval(() => void this.tickAll(), this.tickMs);
    this.interval.unref?.();
    void this.tickAll();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private getStore(workspaceRoot: string): ScheduleStore {
    const key = String(workspaceRoot ?? "").trim() || process.cwd();
    const existing = this.stores.get(key);
    if (existing) {
      return existing;
    }
    const store = new ScheduleStore({ workspacePath: key });
    this.stores.set(key, store);
    return store;
  }

  private getTaskStore(workspaceRoot: string): TaskStore {
    const key = String(workspaceRoot ?? "").trim() || process.cwd();
    const existing = this.taskStores.get(key);
    if (existing) {
      return existing;
    }
    const store = new TaskStore({ workspacePath: key });
    this.taskStores.set(key, store);
    return store;
  }

  private async tickAll(): Promise<void> {
    const roots = Array.from(this.workspaces.values());
    await Promise.allSettled(roots.map(async (root) => await this.tickWorkspace(root)));
  }

  async tickWorkspace(workspaceRoot: string): Promise<void> {
    const root = String(workspaceRoot ?? "").trim() || process.cwd();
    if (this.inFlight.has(root)) {
      return;
    }
    this.inFlight.add(root);
    try {
      const store = this.getStore(root);
      const now = Date.now();

      store.reconcileRuns({ limit: this.reconcileLimit, nowMs: now });

      const dueIds = store.listDueScheduleIds(now, { limit: this.dueLimit });
      for (const scheduleId of dueIds) {
        if (!store.claimScheduleLease({ scheduleId, leaseOwner: this.ownerId, leaseUntil: now + this.leaseTtlMs, nowMs: now })) {
          continue;
        }

        try {
          await this.triggerOne({ workspaceRoot: root, scheduleId, nowMs: now });
        } finally {
          // Ensure lease is released even on failures.
          try {
            store.releaseScheduleLease({ scheduleId, leaseOwner: this.ownerId }, Date.now());
          } catch {
            // ignore
          }
        }
      }
    } finally {
      this.inFlight.delete(root);
    }
  }

  private async triggerOne(options: { workspaceRoot: string; scheduleId: string; nowMs: number }): Promise<void> {
    const root = options.workspaceRoot;
    const store = this.getStore(root);
    const schedule = store.getSchedule(options.scheduleId);
    if (!schedule || !schedule.enabled || schedule.nextRunAt == null) {
      return;
    }

    const runAt = schedule.nextRunAt;
    const externalId = buildExternalId(schedule, runAt);

    const taskStore = this.getTaskStore(root);
    const taskCreated = (() => {
      try {
        taskStore.createTask(
          {
            id: externalId,
            title: schedule.spec.compiledTask.title,
            prompt: schedule.spec.compiledTask.prompt,
            model: "auto",
            inheritContext: false,
            maxRetries: schedule.spec.policy.maxRetries,
            createdBy: "scheduler",
          },
          options.nowMs,
          { status: "pending" },
        );
        return true;
      } catch {
        const existing = taskStore.getTask(externalId);
        return Boolean(existing);
      }
    })();

    const runStatus = taskCreated ? "queued" : "failed";
    const runTaskId = taskCreated ? externalId : null;
    const insert = store.insertRun({ scheduleId: schedule.id, externalId, runAt, taskId: runTaskId, status: runStatus }, options.nowMs);

    if (taskCreated && !insert.inserted) {
      const existingRun = store.getRunByExternalId(externalId);
      if (existingRun && !existingRun.taskId) {
        try {
          store.updateRunByExternalId(externalId, { taskId: externalId }, options.nowMs);
        } catch {
          // ignore
        }
      }
    }

    if (!taskCreated) {
      try {
        store.updateRunByExternalId(
          externalId,
          { status: "failed", error: "Failed to create task", completedAt: options.nowMs },
          options.nowMs,
        );
      } catch {
        // ignore
      }
    }

    const nextRunAt = (() => {
      try {
        return computeNextCronRunAt({
          cron: schedule.spec.schedule.cron,
          timezone: schedule.spec.schedule.timezone,
          afterMs: runAt,
        });
      } catch {
        return null;
      }
    })();

    if (nextRunAt == null) {
      const disabledSpec = {
        ...schedule.spec,
        enabled: false,
        questions: normalizeQuestions([
          ...(schedule.spec.questions ?? []),
          `Cron expression is not supported by runtime: ${String(schedule.spec.schedule.cron ?? "").trim()}`,
        ]),
      };
      store.updateSchedule(
        schedule.id,
        { enabled: false, nextRunAt: null, leaseOwner: null, leaseUntil: null, spec: disabledSpec },
        options.nowMs,
      );
      return;
    }

    store.updateSchedule(schedule.id, { nextRunAt, leaseOwner: null, leaseUntil: null }, options.nowMs);
  }
}

function normalizeQuestions(questions: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const trimmed = String(q ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

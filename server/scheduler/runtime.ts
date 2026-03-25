import crypto from "node:crypto";
import path from "node:path";

import DatabaseConstructor, { type Database as SqliteDatabase } from "better-sqlite3";
import { Runner, SqliteQueue, buildDBClient } from "liteque";

import { getDatabaseInfo } from "../storage/database.js";
import { TaskStore } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";
import { OrchestratorTaskExecutor } from "../tasks/executor.js";
import { SessionManager } from "../telegram/utils/sessionManager.js";
import { ThreadStorage } from "../telegram/utils/threadStorage.js";
import { parseBooleanFlag, parsePositiveIntFlag } from "../utils/flags.js";
import { getErrorMessage } from "../utils/error.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";
import { upsertTaskNotificationBinding } from "../web/taskNotifications/store.js";
import { notifyTaskTerminalViaTelegram } from "../web/taskNotifications/telegramNotifier.js";

import { computeNextCronRunAt } from "./cron.js";
import { ScheduleStore } from "./store.js";
import type { StoredSchedule } from "./store.js";

const defaultLogger = createLogger("SchedulerRuntime");

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

function buildEffectiveTaskPrompt(payload: SchedulerJobPayload, schedule: StoredSchedule): string {
  const runAtIso = new Date(payload.runAt).toISOString();
  const timezone = String(schedule.spec.schedule?.timezone ?? "").trim() || "UTC";
  const compiledPrompt = String(schedule.spec.compiledTask.prompt ?? "");
  return [
    "Scheduler runtime context:",
    `- scheduleId: ${schedule.id}`,
    `- externalId: ${payload.externalId}`,
    `- runAtIso: ${runAtIso}`,
    `- runAtMs: ${payload.runAt}`,
    `- timezone: ${timezone}`,
    `- idempotencyKey: ${payload.externalId}`,
    "",
    "Use the trigger values above as authoritative for this run.",
    "Do not ask the user for missing schedule trigger metadata when it is provided here.",
    "",
    compiledPrompt,
  ].join("\n");
}

type SchedulerJobPayload = {
  workspaceRoot: string;
  scheduleId: string;
  externalId: string;
  runAt: number;
};

type SchedulerExecutionInput = {
  workspaceRoot: string;
  schedule: StoredSchedule;
  task: Task;
  signal: AbortSignal;
};

type SchedulerExecutionResult = {
  resultSummary?: string;
};

type SchedulerExecuteRun = (input: SchedulerExecutionInput) => Promise<SchedulerExecutionResult>;

type SchedulerRuntimeLogger = Pick<Logger, "warn" | "debug" | "info">;

type SchedulerWarningContext = {
  stage: string;
  workspaceRoot: string;
  scheduleId: string;
  externalId?: string | null;
  taskId?: string | null;
};

type WorkspaceSchedulerState = {
  store: ScheduleStore;
  taskStore: TaskStore;
  queue: SqliteQueue<SchedulerJobPayload>;
  queueRawDb: SqliteDatabase;
  runner: Runner<SchedulerJobPayload, SchedulerExecutionResult>;
  executor: OrchestratorTaskExecutor;
  runnerPromise: Promise<void> | null;
};

function hashTaskId(taskId: string): number {
  const normalized = String(taskId ?? "").trim();
  if (!normalized) return 0;
  const compact = normalized.replace(/-/g, "");
  const hex = compact.slice(0, 8);
  const parsed = Number.parseInt(hex, 16);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildQueueName(workspaceRoot: string): string {
  const digest = crypto.createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 12);
  return `ads_scheduler_v1_${digest}`;
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = String(workspaceRoot ?? "").trim();
  return detectWorkspaceFrom(normalized || process.cwd());
}

function resolveLitequeDbPath(workspaceRoot: string): string {
  const base = getDatabaseInfo(workspaceRoot).path;
  const ext = path.extname(base);
  if (!ext) {
    return `${base}.liteque.db`;
  }
  return `${base.slice(0, -ext.length)}.liteque${ext}`;
}

function generateAllocationId(): string {
  return Math.random().toString(36).substring(2, 15);
}

type LitequeDequeuedRow = {
  id: number;
  payload: string;
  priority: number;
  allocationId: string;
  numRunsLeft: number;
  maxNumRuns: number;
};

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

function scheduleRequestsTelegramDelivery(schedule: StoredSchedule): boolean {
  return Array.isArray(schedule.spec.delivery?.channels) && schedule.spec.delivery.channels.includes("telegram");
}

function resolveScheduleTelegramChatId(schedule: StoredSchedule): string | null {
  const chatId = String(schedule.spec.delivery?.telegram?.chatId ?? "").trim();
  return chatId || null;
}

export class SchedulerRuntime {
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private readonly leaseTtlMs: number;
  private readonly dueLimit: number;
  private readonly reconcileLimit: number;
  private readonly ownerId: string;
  private readonly runnerPollMs: number;
  private readonly runnerTimeoutSecs: number;
  private readonly runnerConcurrency: number;
  private readonly adsStateDir: string;
  private readonly executeRun: SchedulerExecuteRun;
  private readonly logger: SchedulerRuntimeLogger;

  private interval: NodeJS.Timeout | null = null;
  private readonly workspaces = new Set<string>();
  private readonly states = new Map<string, WorkspaceSchedulerState>();
  private readonly inFlight = new Set<string>();

  constructor(options?: {
    enabled?: boolean;
    tickMs?: number;
    leaseTtlMs?: number;
    dueLimit?: number;
    reconcileLimit?: number;
    ownerId?: string;
    runnerPollMs?: number;
    runnerTimeoutSecs?: number;
    runnerConcurrency?: number;
    adsStateDir?: string;
    executeRun?: SchedulerExecuteRun;
    logger?: SchedulerRuntimeLogger;
  }) {
    this.enabled = options?.enabled ?? parseBooleanFlag(process.env.ADS_SCHEDULER_ENABLED, true);
    this.tickMs = options?.tickMs ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_TICK_MS, 5000);
    this.leaseTtlMs = options?.leaseTtlMs ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_LEASE_TTL_MS, 30_000);
    this.dueLimit = options?.dueLimit ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_DUE_LIMIT, 20);
    this.reconcileLimit = options?.reconcileLimit ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_RECONCILE_LIMIT, 200);
    this.ownerId = options?.ownerId ?? crypto.randomUUID();
    this.runnerPollMs = options?.runnerPollMs ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_RUNNER_POLL_MS, 1000);
    this.runnerTimeoutSecs =
      options?.runnerTimeoutSecs ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_RUNNER_TIMEOUT_SECS, 1800);
    this.runnerConcurrency =
      options?.runnerConcurrency ?? parsePositiveIntFlag(process.env.ADS_SCHEDULER_RUNNER_CONCURRENCY, 1);
    this.adsStateDir = options?.adsStateDir ?? resolveAdsStateDir();
    this.executeRun = options?.executeRun ?? (async (input) => await this.defaultExecuteRun(input));
    this.logger = options?.logger ?? defaultLogger;
  }

  registerWorkspace(workspaceRoot: string): void {
    const normalized = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalized) return;
    this.workspaces.add(normalized);
    this.getState(normalized);
    if (this.interval && this.enabled) {
      this.startWorkspaceRunner(normalized);
    }
  }

  start(): void {
    if (!this.enabled) {
      return;
    }
    if (this.interval) {
      return;
    }
    for (const root of this.workspaces.values()) {
      this.startWorkspaceRunner(root);
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
    for (const state of this.states.values()) {
      try {
        state.runner.stop();
      } catch {
        // ignore
      }
      try {
        state.queueRawDb.close();
      } catch {
        // ignore
      }
    }
  }

  private getState(workspaceRoot: string): WorkspaceSchedulerState {
    const key = normalizeWorkspaceRoot(workspaceRoot);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }

    const scheduleStore = new ScheduleStore({ workspacePath: key });
    const taskStore = new TaskStore({ workspacePath: key });
    const dbPath = resolveLitequeDbPath(key);
    const queueDb = buildDBClient(dbPath, { runMigrations: true });
    const queueRawDb = new DatabaseConstructor(dbPath, { readonly: false, fileMustExist: false });
    queueRawDb.pragma("journal_mode = WAL");
    queueRawDb.pragma("foreign_keys = ON");
    queueRawDb.pragma("busy_timeout = 5000");
    const queue = new SqliteQueue<SchedulerJobPayload>(buildQueueName(key), queueDb, {
      defaultJobArgs: { numRetries: 0 },
      keepFailedJobs: true,
    });
    this.patchQueueAttemptDequeue(queue, queueRawDb);

    const schedulerModelOverride = String(process.env.ADS_SCHEDULER_MODEL ?? process.env.TASK_QUEUE_DEFAULT_MODEL ?? "").trim() || undefined;
    const sessionManager = new SessionManager(
      0,
      0,
      "danger-full-access",
      schedulerModelOverride,
      new ThreadStorage({
        namespace: `scheduler:${buildQueueName(key)}`,
        storagePath: path.join(this.adsStateDir, `scheduler-threads-${buildQueueName(key)}.json`),
      }),
    );

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: (task) => sessionManager.getOrCreate(hashTaskId(task.id), key, true),
      store: taskStore,
      autoModelOverride: schedulerModelOverride,
    });

    const runner = new Runner<SchedulerJobPayload, SchedulerExecutionResult>(
      queue,
      {
        run: async (job) => await this.runScheduledJob(job.data, job.abortSignal),
        onComplete: async (job, result) => {
          await this.handleJobComplete(job.data, result);
        },
        onError: async (job) => {
          await this.handleJobError(job.data, job.error, job.numRetriesLeft, job.runNumber);
        },
      },
      {
        concurrency: this.runnerConcurrency,
        pollIntervalMs: this.runnerPollMs,
        timeoutSecs: this.runnerTimeoutSecs,
      },
    );

    const state: WorkspaceSchedulerState = {
      store: scheduleStore,
      taskStore,
      queue,
      queueRawDb,
      runner,
      executor,
      runnerPromise: null,
    };
    this.states.set(key, state);
    return state;
  }

  private async tickAll(): Promise<void> {
    const roots = Array.from(this.workspaces.values());
    await Promise.allSettled(roots.map(async (root) => await this.tickWorkspace(root)));
  }

  async tickWorkspace(workspaceRoot: string): Promise<void> {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    if (this.inFlight.has(root)) {
      return;
    }
    this.inFlight.add(root);
    try {
      const state = this.getState(root);
      const store = state.store;
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
          } catch (error) {
            this.warnScheduler(
              {
                stage: "release-lease",
                workspaceRoot: root,
                scheduleId,
              },
              error,
            );
          }
        }
      }
    } finally {
      this.inFlight.delete(root);
    }
  }

  private async triggerOne(options: { workspaceRoot: string; scheduleId: string; nowMs: number }): Promise<void> {
    const root = options.workspaceRoot;
    const state = this.getState(root);
    const store = state.store;
    const schedule = store.getSchedule(options.scheduleId);
    if (!schedule || !schedule.enabled || schedule.nextRunAt == null) {
      return;
    }

    const runAt = schedule.nextRunAt;
    const externalId = buildExternalId(schedule, runAt);
    const existingRun = store.getRunByExternalId(externalId);
    const isTerminal =
      existingRun?.status === "completed" || existingRun?.status === "failed" || existingRun?.status === "cancelled";
    if (!isTerminal) {
      if (!existingRun) {
        store.insertRun({ scheduleId: schedule.id, externalId, runAt, taskId: null, status: "queued" }, options.nowMs);
      }
      this.ensureTaskForRun(
        {
          workspaceRoot: root,
          scheduleId: schedule.id,
          externalId,
          runAt,
        },
        schedule,
        options.nowMs,
      );
      await state.queue.enqueue(
        {
          workspaceRoot: root,
          scheduleId: schedule.id,
          externalId,
          runAt,
        },
        {
          numRetries: Math.max(0, schedule.spec.policy.maxRetries),
          idempotencyKey: externalId,
        },
      );
    }

    let nextRunError: unknown = null;
    const nextRunAt = (() => {
      try {
        return computeNextCronRunAt({
          cron: schedule.spec.schedule.cron,
          timezone: schedule.spec.schedule.timezone,
          afterMs: runAt,
        });
      } catch (error) {
        nextRunError = error;
        return null;
      }
    })();

    if (nextRunAt == null) {
      this.warnScheduler(
        {
          stage: "compute-next-run",
          workspaceRoot: root,
          scheduleId: schedule.id,
          externalId,
        },
        nextRunError ?? new Error("computeNextCronRunAt returned null and schedule will be disabled"),
      );
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

  private startWorkspaceRunner(workspaceRoot: string): void {
    const state = this.getState(workspaceRoot);
    if (state.runnerPromise) {
      return;
    }
    state.runnerPromise = state.runner
      .run()
      .catch((error) => {
        this.warnScheduler(
          {
            stage: "runner-crash",
            workspaceRoot,
            scheduleId: "n/a",
          },
          error,
        );
      })
      .finally(() => {
        state.runnerPromise = null;
      });
  }

  private patchQueueAttemptDequeue(queue: SqliteQueue<SchedulerJobPayload>, db: SqliteDatabase): void {
    const queueName = queue.name();
    const queueLike = queue as unknown as {
      attemptDequeue: (options: { timeoutSecs: number }) => Promise<LitequeDequeuedRow | null>;
    };
    queueLike.attemptDequeue = async (options: { timeoutSecs: number }) => {
      const timeoutSecs = Number.isFinite(options.timeoutSecs) ? Math.max(1, Math.floor(options.timeoutSecs)) : 60;
      const nowMs = Date.now();
      const nowSec = Math.floor(nowMs / 1000);

      const row = db
        .prepare(
          `SELECT
             id AS id,
             payload AS payload,
             priority AS priority,
             allocationId AS allocationId,
             numRunsLeft AS numRunsLeft,
             maxNumRuns AS maxNumRuns
           FROM tasks
           WHERE queue = ?
             AND (availableAt IS NULL OR availableAt <= ?)
             AND (
               status = 'pending'
               OR status = 'pending_retry'
               OR (status = 'running' AND expireAt IS NOT NULL AND expireAt < ?)
             )
           ORDER BY priority ASC, createdAt ASC
           LIMIT 1`,
        )
        .get(queueName, nowMs, nowSec) as LitequeDequeuedRow | undefined;

      if (!row) {
        return null;
      }

      if (row.numRunsLeft === 0) {
        await queue.finalize(row.id, row.allocationId, "failed");
        return null;
      }

      const allocationId = generateAllocationId();
      const result = db
        .prepare(
          `UPDATE tasks
           SET status = 'running',
               numRunsLeft = ?,
               allocationId = ?,
               expireAt = ?
           WHERE id = ?
             AND allocationId = ?`,
        )
        .run(row.numRunsLeft - 1, allocationId, nowSec + timeoutSecs, row.id, row.allocationId) as { changes?: number };

      if (!result || result.changes !== 1) {
        return null;
      }

      return {
        ...row,
        allocationId,
        numRunsLeft: row.numRunsLeft - 1,
      };
    };
  }

  private parsePayload(raw: unknown): SchedulerJobPayload | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const workspaceRoot = normalizeWorkspaceRoot(String(record.workspaceRoot ?? ""));
    const scheduleId = String(record.scheduleId ?? "").trim();
    const externalId = String(record.externalId ?? "").trim();
    const runAtRaw = Number(record.runAt);
    const runAt = Number.isFinite(runAtRaw) ? Math.floor(runAtRaw) : NaN;
    if (!workspaceRoot || !scheduleId || !externalId || !Number.isFinite(runAt)) {
      return null;
    }
    return { workspaceRoot, scheduleId, externalId, runAt };
  }

  private ensureTaskForRun(payload: SchedulerJobPayload, schedule: StoredSchedule, now: number): Task {
    const state = this.getState(payload.workspaceRoot);
    const existing = state.taskStore.getTask(payload.externalId);
    if (existing) {
      return existing;
    }
    const effectivePrompt = buildEffectiveTaskPrompt(payload, schedule);
    try {
      return state.taskStore.createTask(
        {
          id: payload.externalId,
          title: schedule.spec.compiledTask.title,
          prompt: effectivePrompt,
          model: "auto",
          inheritContext: false,
          maxRetries: Math.max(0, schedule.spec.policy.maxRetries),
          createdBy: "scheduler",
        },
        now,
        { status: "pending" },
      );
    } catch {
      const fallback = state.taskStore.getTask(payload.externalId);
      if (!fallback) {
        throw new Error(`Failed to create scheduler task: ${payload.externalId}`);
      }
      return fallback;
    }
  }

  private async defaultExecuteRun(input: SchedulerExecutionInput): Promise<SchedulerExecutionResult> {
    const state = this.getState(input.workspaceRoot);
    return await state.executor.execute(input.task, { signal: input.signal });
  }

  private warnScheduler(context: SchedulerWarningContext, error: unknown): void {
    const fields = [
      `stage=${context.stage}`,
      `workspaceRoot=${context.workspaceRoot}`,
      `scheduleId=${context.scheduleId}`,
    ];
    if (context.externalId) {
      fields.push(`externalId=${context.externalId}`);
    }
    if (context.taskId) {
      fields.push(`taskId=${context.taskId}`);
    }
    fields.push(`err=${getErrorMessage(error)}`);
    this.logger.warn(fields.join(" "), error);
  }

  private async runScheduledJob(rawPayload: unknown, signal: AbortSignal): Promise<SchedulerExecutionResult> {
    const payload = this.parsePayload(rawPayload);
    if (!payload) {
      return {};
    }
    const state = this.getState(payload.workspaceRoot);
    const now = Date.now();

    const schedule = state.store.getSchedule(payload.scheduleId);
    if (!schedule || !schedule.enabled) {
      try {
        state.store.updateRunByExternalId(
          payload.externalId,
          {
            status: "cancelled",
            error: schedule ? "Schedule is disabled" : "Schedule not found",
            completedAt: now,
          },
          now,
        );
      } catch (persistError) {
        this.warnScheduler(
          {
            stage: "mark-run-cancelled",
            workspaceRoot: payload.workspaceRoot,
            scheduleId: payload.scheduleId,
            externalId: payload.externalId,
          },
          persistError,
        );
      }
      return {};
    }

    const currentRun = state.store.getRunByExternalId(payload.externalId);
    if (currentRun?.status === "completed" || currentRun?.status === "cancelled") {
      return { resultSummary: currentRun.result ?? undefined };
    }

    const task = this.ensureTaskForRun(payload, schedule, now);
    const runningTask = state.taskStore.updateTask(
      task.id,
      {
        status: "running",
        error: null,
        result: null,
        startedAt: now,
        completedAt: null,
      },
      now,
    );

    try {
      state.store.updateRunByExternalId(
        payload.externalId,
        {
          status: "running",
          taskId: runningTask.id,
          error: null,
          startedAt: now,
          completedAt: null,
        },
        now,
      );
    } catch (persistError) {
      this.warnScheduler(
        {
          stage: "mark-run-running",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
          taskId: runningTask.id,
        },
        persistError,
      );
    }

    if (scheduleRequestsTelegramDelivery(schedule)) {
      try {
        upsertTaskNotificationBinding({
          authUserId: "",
          workspaceRoot: payload.workspaceRoot,
          taskId: runningTask.id,
          taskTitle: runningTask.title,
          telegramChatId: resolveScheduleTelegramChatId(schedule),
          now,
          logger: this.logger,
        });
      } catch (persistError) {
        this.warnScheduler(
          {
            stage: "bind-task-telegram",
            workspaceRoot: payload.workspaceRoot,
            scheduleId: payload.scheduleId,
            externalId: payload.externalId,
            taskId: runningTask.id,
          },
          persistError,
        );
      }
    }

    return await this.executeRun({
      workspaceRoot: payload.workspaceRoot,
      schedule,
      task: runningTask,
      signal,
    });
  }

  private async handleJobComplete(rawPayload: unknown, result: SchedulerExecutionResult): Promise<void> {
    const payload = this.parsePayload(rawPayload);
    if (!payload) {
      return;
    }
    const state = this.getState(payload.workspaceRoot);
    const now = Date.now();
    const resultSummary = String(result.resultSummary ?? "").trim() || null;
    const schedule = state.store.getSchedule(payload.scheduleId);

    try {
      state.store.updateRunByExternalId(
        payload.externalId,
        {
          status: "completed",
          result: resultSummary,
          error: null,
          completedAt: now,
        },
        now,
      );
    } catch (persistError) {
      this.warnScheduler(
        {
          stage: "mark-run-completed",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
          taskId: payload.externalId,
        },
        persistError,
      );
    }

    const task = state.taskStore.getTask(payload.externalId);
    if (!task) {
      return;
    }
    try {
      const completed = state.taskStore.updateTask(
        task.id,
        {
          status: "completed",
          result: resultSummary,
          error: null,
          completedAt: now,
        },
        now,
      );
      if (completed.result && completed.result.trim()) {
        try {
          state.taskStore.saveContext(completed.id, { contextType: "summary", content: completed.result }, now);
        } catch (persistError) {
          this.warnScheduler(
            {
              stage: "save-summary",
              workspaceRoot: payload.workspaceRoot,
              scheduleId: payload.scheduleId,
              externalId: payload.externalId,
              taskId: completed.id,
            },
            persistError,
          );
        }
      }
      if (schedule && scheduleRequestsTelegramDelivery(schedule)) {
        notifyTaskTerminalViaTelegram({
          logger: this.logger,
          workspaceRoot: payload.workspaceRoot,
          task: completed,
          terminalStatus: "completed",
          eventTs: now,
        });
      }
    } catch (persistError) {
      this.warnScheduler(
        {
          stage: "mark-task-completed",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
          taskId: task.id,
        },
        persistError,
      );
    }
  }

  private async handleJobError(
    rawPayload: unknown,
    error: unknown,
    numRetriesLeft: number,
    runNumber: number,
  ): Promise<void> {
    const payload = this.parsePayload(rawPayload);
    if (!payload) {
      return;
    }
    const state = this.getState(payload.workspaceRoot);
    const task = state.taskStore.getTask(payload.externalId);
    const schedule = state.store.getSchedule(payload.scheduleId);
    const now = Date.now();
    const terminal = numRetriesLeft <= 0;
    const message = getErrorMessage(error);

    try {
      state.store.updateRunByExternalId(
        payload.externalId,
        {
          status: terminal ? "failed" : "queued",
          error: message,
          completedAt: terminal ? now : null,
        },
        now,
      );
    } catch (persistError) {
      this.warnScheduler(
        {
          stage: terminal ? "mark-run-failed" : "mark-run-queued",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
          taskId: task?.id ?? null,
        },
        persistError,
      );
    }

    if (!task) {
      return;
    }

    try {
      const updated = state.taskStore.updateTask(
        task.id,
        {
          status: terminal ? "failed" : "pending",
          error: message,
          result: null,
          retryCount: Math.max(task.retryCount, runNumber + 1),
          completedAt: terminal ? now : null,
        },
        now,
      );
      if (terminal) {
        try {
          state.taskStore.saveContext(updated.id, { contextType: "summary", content: `[Failed]\n${message}` }, now);
        } catch (persistError) {
          this.warnScheduler(
            {
              stage: "save-summary",
              workspaceRoot: payload.workspaceRoot,
              scheduleId: payload.scheduleId,
              externalId: payload.externalId,
              taskId: updated.id,
            },
            persistError,
          );
        }
        if (schedule && scheduleRequestsTelegramDelivery(schedule)) {
          notifyTaskTerminalViaTelegram({
            logger: this.logger,
            workspaceRoot: payload.workspaceRoot,
            task: updated,
            terminalStatus: "failed",
            eventTs: now,
          });
        }
      }
    } catch (persistError) {
      this.warnScheduler(
        {
          stage: terminal ? "mark-task-failed" : "mark-task-pending",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
          taskId: task.id,
        },
        persistError,
      );
    }
  }
}

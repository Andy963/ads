import fs from "node:fs";
import path from "node:path";

import DatabaseConstructor, { type Database as SqliteDatabase } from "better-sqlite3";
import { Runner, SqliteQueue, buildDBClient } from "liteque";

import { TaskStore } from "../tasks/store.js";
import { OrchestratorTaskExecutor } from "../tasks/executor.js";
import { SessionManager, resolveSessionAgentAllowlist } from "../telegram/utils/sessionManager.js";
import { ThreadStorage } from "../telegram/utils/threadStorage.js";

import { ScheduleStore } from "./store.js";
import type { SchedulerExecutionResult, SchedulerJobPayload, WorkspaceSchedulerState, LitequeDequeuedRow } from "./runtimeSupport.js";
import {
  buildQueueName,
  generateAllocationId,
  hashTaskId,
  resolveLitequeDbPath,
} from "./runtimeSupport.js";

type CreateWorkspaceSchedulerStateOptions = {
  workspaceRoot: string;
  adsStateDir: string;
  runnerPollMs: number;
  runnerTimeoutSecs: number;
  runnerConcurrency: number;
  runJob: (rawPayload: unknown, signal: AbortSignal) => Promise<SchedulerExecutionResult>;
  onComplete: (rawPayload: unknown, result: SchedulerExecutionResult) => Promise<void>;
  onError: (rawPayload: unknown, error: unknown, numRetriesLeft: number, runNumber: number) => Promise<void>;
};

export function createWorkspaceSchedulerState(options: CreateWorkspaceSchedulerStateOptions): WorkspaceSchedulerState {
  const scheduleStore = new ScheduleStore({ workspacePath: options.workspaceRoot });
  const taskStore = new TaskStore({ workspacePath: options.workspaceRoot });
  const dbPath = resolveLitequeDbPath(options.workspaceRoot);
  const queueDb = buildDBClient(dbPath, { runMigrations: true });
  const queueRawDb = new DatabaseConstructor(dbPath, { readonly: false, fileMustExist: false });
  queueRawDb.pragma("journal_mode = WAL");
  queueRawDb.pragma("foreign_keys = ON");
  queueRawDb.pragma("busy_timeout = 5000");
  const queue = new SqliteQueue<SchedulerJobPayload>(buildQueueName(options.workspaceRoot), queueDb, {
    defaultJobArgs: { numRetries: 0 },
    keepFailedJobs: true,
  });
  patchQueueAttemptDequeue(queue, queueRawDb);

  const schedulerModelOverride =
    String(process.env.ADS_SCHEDULER_MODEL ?? process.env.TASK_QUEUE_DEFAULT_MODEL ?? "").trim() || undefined;
  const sessionManager = new SessionManager(
    0,
    0,
    "danger-full-access",
    schedulerModelOverride,
    new ThreadStorage({
      namespace: `scheduler:${buildQueueName(options.workspaceRoot)}`,
      storagePath: path.join(options.adsStateDir, `scheduler-threads-${buildQueueName(options.workspaceRoot)}.json`),
    }),
    undefined,
    {
      agentAllowlist: resolveSessionAgentAllowlist("scheduler-runtime"),
    },
  );

  const executor = new OrchestratorTaskExecutor({
    getOrchestrator: (task) => sessionManager.getOrCreate(hashTaskId(task.id), options.workspaceRoot, true),
    store: taskStore,
    workspaceRoot: options.workspaceRoot,
    autoModelOverride: schedulerModelOverride,
  });

  const runner = new Runner<SchedulerJobPayload, SchedulerExecutionResult>(
    queue,
    {
      run: async (job) => await options.runJob(job.data, job.abortSignal),
      onComplete: async (job, result) => {
        await options.onComplete(job.data, result);
      },
      onError: async (job) => {
        await options.onError(job.data, job.error, job.numRetriesLeft, job.runNumber);
      },
    },
    {
      concurrency: options.runnerConcurrency,
      pollIntervalMs: options.runnerPollMs,
      timeoutSecs: options.runnerTimeoutSecs,
    },
  );

  return {
    store: scheduleStore,
    taskStore,
    queue,
    queueRawDb,
    runner,
    executor,
    runnerPromise: null,
    lastTouchedAt: Date.now(),
  };
}

export function disposeWorkspaceSchedulerState(state: WorkspaceSchedulerState): void {
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

export function hasDueSchedules(workspaceRoot: string, now: number): boolean {
  return new ScheduleStore({ workspacePath: workspaceRoot }).listDueScheduleIds(now, { limit: 1 }).length > 0;
}

export async function hasQueuedSchedulerJobs(workspaceRoot: string, state?: WorkspaceSchedulerState): Promise<boolean> {
  if (state) {
    const stats = await state.queue.stats();
    return stats.pending + stats.pending_retry + stats.running > 0;
  }

  const dbPath = resolveLitequeDbPath(workspaceRoot);
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  let db: SqliteDatabase | null = null;
  try {
    db = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT COUNT(1) AS count
         FROM tasks
         WHERE queue = ?
           AND status IN ('pending', 'pending_retry', 'running')`,
      )
      .get(buildQueueName(workspaceRoot)) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) > 0;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function patchQueueAttemptDequeue(queue: SqliteQueue<SchedulerJobPayload>, db: SqliteDatabase): void {
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

import crypto from "node:crypto";

import type { Task } from "../tasks/types.js";
import { getErrorMessage } from "../utils/error.js";
import { parseBooleanFlag, parsePositiveIntFlag } from "../utils/flags.js";
import { createLogger } from "../utils/logger.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";

import {
  ensureTaskForRun as ensureTaskForRunHelper,
  handleScheduledJobComplete,
  handleScheduledJobError,
  runScheduledJob as runScheduledJobHelper,
} from "./runtimeJobLifecycle.js";
import { triggerScheduleRun } from "./runtimeScheduling.js";
import {
  createWorkspaceSchedulerState,
  disposeWorkspaceSchedulerState,
  hasDueSchedules,
  hasQueuedSchedulerJobs,
} from "./runtimeState.js";
import {
  normalizeWorkspaceRoot,
  type SchedulerExecuteRun,
  type SchedulerExecutionInput,
  type SchedulerExecutionResult,
  type SchedulerJobPayload,
  type SchedulerRuntimeLogger,
  type SchedulerWarningContext,
  type WorkspaceSchedulerState,
} from "./runtimeSupport.js";
import type { StoredSchedule } from "./store.js";

const defaultLogger = createLogger("SchedulerRuntime");

export class SchedulerRuntime {
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private readonly idleRecycleMs: number;
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
    idleRecycleMs?: number;
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
    const idleRecycleRaw = Number.parseInt(String(process.env.ADS_SCHEDULER_IDLE_RECYCLE_MS ?? ""), 10);
    this.idleRecycleMs =
      options?.idleRecycleMs ?? (Number.isFinite(idleRecycleRaw) && idleRecycleRaw >= 0 ? idleRecycleRaw : 300_000);
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
    if (this.interval && this.enabled) {
      void this.tickWorkspace(normalized);
    }
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
    for (const [workspaceRoot, state] of this.states.entries()) {
      this.disposeState(workspaceRoot, state);
    }
  }

  private getState(workspaceRoot: string): WorkspaceSchedulerState {
    const key = normalizeWorkspaceRoot(workspaceRoot);
    const existing = this.states.get(key);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing;
    }

    const state = createWorkspaceSchedulerState({
      workspaceRoot: key,
      adsStateDir: this.adsStateDir,
      runnerPollMs: this.runnerPollMs,
      runnerTimeoutSecs: this.runnerTimeoutSecs,
      runnerConcurrency: this.runnerConcurrency,
      runJob: async (rawPayload, signal) => await this.runScheduledJob(rawPayload, signal),
      onComplete: async (rawPayload, result) => {
        await this.handleJobComplete(rawPayload, result);
      },
      onError: async (rawPayload, error, numRetriesLeft, runNumber) => {
        await this.handleJobError(rawPayload, error, numRetriesLeft, runNumber);
      },
    });
    this.states.set(key, state);
    return state;
  }

  private disposeState(workspaceRoot: string, state: WorkspaceSchedulerState): void {
    disposeWorkspaceSchedulerState(state);
    this.states.delete(workspaceRoot);
  }

  private hasDueSchedules(workspaceRoot: string, now: number): boolean {
    return hasDueSchedules(workspaceRoot, now);
  }

  private async hasQueuedJobs(workspaceRoot: string, state?: WorkspaceSchedulerState): Promise<boolean> {
    return await hasQueuedSchedulerJobs(workspaceRoot, state);
  }

  private async workspaceNeedsMaterialization(workspaceRoot: string, now: number): Promise<boolean> {
    if (this.states.has(workspaceRoot)) {
      return true;
    }
    if (this.hasDueSchedules(workspaceRoot, now)) {
      return true;
    }
    return await this.hasQueuedJobs(workspaceRoot);
  }

  private async recycleIdleStates(now = Date.now()): Promise<void> {
    if (this.idleRecycleMs <= 0) {
      return;
    }

    for (const [workspaceRoot, state] of this.states.entries()) {
      if (this.inFlight.has(workspaceRoot)) {
        continue;
      }
      if (state.runnerPromise) {
        continue;
      }
      if (now - state.lastTouchedAt < this.idleRecycleMs) {
        continue;
      }
      if (await this.hasQueuedJobs(workspaceRoot, state)) {
        continue;
      }
      this.disposeState(workspaceRoot, state);
    }
  }

  private async tickAll(): Promise<void> {
    const roots = Array.from(this.workspaces.values());
    await Promise.allSettled(roots.map(async (root) => await this.tickWorkspace(root)));
  }

  async tickWorkspace(workspaceRoot: string): Promise<void> {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    await this.recycleIdleStates(Date.now());
    if (this.inFlight.has(root)) {
      return;
    }
    this.inFlight.add(root);
    try {
      const now = Date.now();
      if (!(await this.workspaceNeedsMaterialization(root, now))) {
        return;
      }

      const state = this.getState(root);
      const store = state.store;

      store.reconcileRuns({ limit: this.reconcileLimit, nowMs: now });

      const dueIds = store.listDueScheduleIds(now, { limit: this.dueLimit });
      for (const scheduleId of dueIds) {
        if (!store.claimScheduleLease({ scheduleId, leaseOwner: this.ownerId, leaseUntil: now + this.leaseTtlMs, nowMs: now })) {
          continue;
        }

        try {
          await this.triggerOne({ workspaceRoot: root, scheduleId, nowMs: now });
        } finally {
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

      if (this.enabled && (await this.hasQueuedJobs(root, state))) {
        this.startWorkspaceRunner(root);
      } else {
        await this.recycleIdleStates(Date.now());
      }
    } finally {
      this.inFlight.delete(root);
    }
  }

  private async triggerOne(options: { workspaceRoot: string; scheduleId: string; nowMs: number }): Promise<void> {
    await triggerScheduleRun({
      workspaceRoot: options.workspaceRoot,
      scheduleId: options.scheduleId,
      nowMs: options.nowMs,
      getState: (workspaceRoot) => this.getState(workspaceRoot),
      ensureTaskForRun: (payload, schedule, now) => this.ensureTaskForRun(payload, schedule, now),
      warnScheduler: (context, error) => this.warnScheduler(context, error),
    });
  }

  private startWorkspaceRunner(workspaceRoot: string): void {
    const state = this.getState(workspaceRoot);
    if (state.runnerPromise) {
      return;
    }
    state.lastTouchedAt = Date.now();
    state.runnerPromise = state.runner
      .runUntilEmpty()
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
        state.lastTouchedAt = Date.now();
        state.runnerPromise = null;
      });
  }

  private ensureTaskForRun(payload: SchedulerJobPayload, schedule: StoredSchedule, now: number): Task {
    return ensureTaskForRunHelper({
      getState: (workspaceRoot) => this.getState(workspaceRoot),
      payload,
      schedule,
      now,
    });
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
    return await runScheduledJobHelper({
      rawPayload,
      signal,
      getState: (workspaceRoot) => this.getState(workspaceRoot),
      executeRun: this.executeRun,
      warnScheduler: (context, error) => this.warnScheduler(context, error),
      logger: this.logger,
    });
  }

  private async handleJobComplete(rawPayload: unknown, result: SchedulerExecutionResult): Promise<void> {
    await handleScheduledJobComplete({
      rawPayload,
      result,
      getState: (workspaceRoot) => this.getState(workspaceRoot),
      warnScheduler: (context, error) => this.warnScheduler(context, error),
      logger: this.logger,
    });
  }

  private async handleJobError(
    rawPayload: unknown,
    error: unknown,
    numRetriesLeft: number,
    runNumber: number,
  ): Promise<void> {
    await handleScheduledJobError({
      rawPayload,
      error,
      numRetriesLeft,
      runNumber,
      getState: (workspaceRoot) => this.getState(workspaceRoot),
      warnScheduler: (context, err) => this.warnScheduler(context, err),
      logger: this.logger,
    });
  }
}

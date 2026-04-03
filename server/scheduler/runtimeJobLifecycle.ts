import type { Task } from "../tasks/types.js";
import { getErrorMessage } from "../utils/error.js";
import { notifyTaskTerminalViaTelegram } from "../web/taskNotifications/telegramNotifier.js";
import { upsertTaskNotificationBinding } from "../web/taskNotifications/store.js";

import {
  buildEffectiveTaskPrompt,
  normalizeWorkspaceRoot,
  resolveScheduleTelegramChatId,
  scheduleRequestsTelegramDelivery,
  type SchedulerExecuteRun,
  type SchedulerExecutionResult,
  type SchedulerJobPayload,
  type SchedulerRuntimeLogger,
  type SchedulerWarningContext,
  type WorkspaceSchedulerState,
} from "./runtimeSupport.js";
import type { StoredSchedule } from "./store.js";

type GetState = (workspaceRoot: string) => WorkspaceSchedulerState;
type WarnScheduler = (context: SchedulerWarningContext, error: unknown) => void;

export function parseSchedulerJobPayload(raw: unknown): SchedulerJobPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const workspaceRoot = normalizeWorkspaceRoot(String(record.workspaceRoot ?? ""));
  const scheduleId = String(record.scheduleId ?? "").trim();
  const externalId = String(record.externalId ?? "").trim();
  const runAtRaw = Number(record.runAt);
  const runAt = Number.isFinite(runAtRaw) ? Math.floor(runAtRaw) : Number.NaN;
  if (!workspaceRoot || !scheduleId || !externalId || !Number.isFinite(runAt)) {
    return null;
  }
  return { workspaceRoot, scheduleId, externalId, runAt };
}

export function ensureTaskForRun(args: {
  getState: GetState;
  payload: SchedulerJobPayload;
  schedule: StoredSchedule;
  now: number;
}): Task {
  const state = args.getState(args.payload.workspaceRoot);
  const existing = state.taskStore.getTask(args.payload.externalId);
  if (existing) {
    return existing;
  }
  const effectivePrompt = buildEffectiveTaskPrompt(args.payload, args.schedule);
  try {
    return state.taskStore.createTask(
      {
        id: args.payload.externalId,
        title: args.schedule.spec.compiledTask.title,
        prompt: effectivePrompt,
        model: "auto",
        inheritContext: false,
        maxRetries: Math.max(0, args.schedule.spec.policy.maxRetries),
        createdBy: "scheduler",
      },
      args.now,
      { status: "pending" },
    );
  } catch {
    const fallback = state.taskStore.getTask(args.payload.externalId);
    if (!fallback) {
      throw new Error(`Failed to create scheduler task: ${args.payload.externalId}`);
    }
    return fallback;
  }
}

export async function runScheduledJob(args: {
  rawPayload: unknown;
  signal: AbortSignal;
  getState: GetState;
  executeRun: SchedulerExecuteRun;
  warnScheduler: WarnScheduler;
  logger: SchedulerRuntimeLogger;
}): Promise<SchedulerExecutionResult> {
  const payload = parseSchedulerJobPayload(args.rawPayload);
  if (!payload) {
    return {};
  }
  const state = args.getState(payload.workspaceRoot);
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
      args.warnScheduler(
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

  const task = ensureTaskForRun({
    getState: args.getState,
    payload,
    schedule,
    now,
  });
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
    args.warnScheduler(
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
        logger: args.logger,
      });
    } catch (persistError) {
      args.warnScheduler(
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

  return await args.executeRun({
    workspaceRoot: payload.workspaceRoot,
    schedule,
    task: runningTask,
    signal: args.signal,
  });
}

export async function handleScheduledJobComplete(args: {
  rawPayload: unknown;
  result: SchedulerExecutionResult;
  getState: GetState;
  warnScheduler: WarnScheduler;
  logger: SchedulerRuntimeLogger;
}): Promise<void> {
  const payload = parseSchedulerJobPayload(args.rawPayload);
  if (!payload) {
    return;
  }
  const state = args.getState(payload.workspaceRoot);
  const now = Date.now();
  const resultSummary = String(args.result.resultSummary ?? "").trim() || null;
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
    args.warnScheduler(
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
        args.warnScheduler(
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
        logger: args.logger,
        workspaceRoot: payload.workspaceRoot,
        task: completed,
        terminalStatus: "completed",
        eventTs: now,
      });
    }
  } catch (persistError) {
    args.warnScheduler(
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

export async function handleScheduledJobError(args: {
  rawPayload: unknown;
  error: unknown;
  numRetriesLeft: number;
  runNumber: number;
  getState: GetState;
  warnScheduler: WarnScheduler;
  logger: SchedulerRuntimeLogger;
}): Promise<void> {
  const payload = parseSchedulerJobPayload(args.rawPayload);
  if (!payload) {
    return;
  }
  const state = args.getState(payload.workspaceRoot);
  const task = state.taskStore.getTask(payload.externalId);
  const schedule = state.store.getSchedule(payload.scheduleId);
  const now = Date.now();
  const terminal = args.numRetriesLeft <= 0;
  const message = getErrorMessage(args.error);

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
    args.warnScheduler(
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
        retryCount: Math.max(task.retryCount, args.runNumber + 1),
        completedAt: terminal ? now : null,
      },
      now,
    );
    if (terminal) {
      try {
        state.taskStore.saveContext(updated.id, { contextType: "summary", content: `[Failed]\n${message}` }, now);
      } catch (persistError) {
        args.warnScheduler(
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
          logger: args.logger,
          workspaceRoot: payload.workspaceRoot,
          task: updated,
          terminalStatus: "failed",
          eventTs: now,
        });
      }
    }
  } catch (persistError) {
    args.warnScheduler(
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

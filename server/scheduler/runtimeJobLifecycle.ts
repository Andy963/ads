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
  const prompt = typeof record.prompt === "string" ? record.prompt : undefined;
  if (!workspaceRoot || !scheduleId || !externalId || !Number.isFinite(runAt)) {
    return null;
  }
  return { workspaceRoot, scheduleId, externalId, runAt, prompt };
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

  try {
    state.store.updateRunByExternalId(
      payload.externalId,
      {
        status: "running",
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
      },
      persistError,
    );
  }

  if (scheduleRequestsTelegramDelivery(schedule)) {
    try {
      upsertTaskNotificationBinding({
        authUserId: "",
        workspaceRoot: payload.workspaceRoot,
        taskId: payload.externalId,
        taskTitle: schedule.spec.compiledTask.title,
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
        },
        persistError,
      );
    }
  }

  const effectivePrompt = payload.prompt || buildEffectiveTaskPrompt(payload, schedule);
  const taskDescriptor = {
    id: payload.externalId,
    title: schedule.spec.compiledTask.title,
    prompt: effectivePrompt,
  };

  return await args.executeRun({
    workspaceRoot: payload.workspaceRoot,
    schedule,
    payload,
    prompt: effectivePrompt,
    task: taskDescriptor,
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
  const currentRun = state.store.getRunByExternalId(payload.externalId);

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
      },
      persistError,
    );
  }

  if (schedule && scheduleRequestsTelegramDelivery(schedule)) {
    try {
      notifyTaskTerminalViaTelegram({
        logger: args.logger,
        workspaceRoot: payload.workspaceRoot,
        task: {
          id: payload.externalId,
          title: schedule.spec.compiledTask.title,
          status: "completed",
          startedAt: currentRun?.startedAt ?? null,
          completedAt: now,
          result: resultSummary,
        },
        terminalStatus: "completed",
        eventTs: now,
      });
    } catch (notifyError) {
      args.warnScheduler(
        {
          stage: "notify-telegram-completed",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
        },
        notifyError,
      );
    }
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
  const schedule = state.store.getSchedule(payload.scheduleId);
  const currentRun = state.store.getRunByExternalId(payload.externalId);
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
      },
      persistError,
    );
  }

  if (terminal && schedule && scheduleRequestsTelegramDelivery(schedule)) {
    try {
      notifyTaskTerminalViaTelegram({
        logger: args.logger,
        workspaceRoot: payload.workspaceRoot,
        task: {
          id: payload.externalId,
          title: schedule.spec.compiledTask.title,
          status: "failed",
          startedAt: currentRun?.startedAt ?? null,
          completedAt: now,
          result: `[Failed]\n${message}`,
        },
        terminalStatus: "failed",
        eventTs: now,
      });
    } catch (notifyError) {
      args.warnScheduler(
        {
          stage: "notify-telegram-failed",
          workspaceRoot: payload.workspaceRoot,
          scheduleId: payload.scheduleId,
          externalId: payload.externalId,
        },
        notifyError,
      );
    }
  }
}

import { computeNextCronRunAt } from "./cron.js";
import {
  buildExternalId,
  buildEffectiveTaskPrompt,
  normalizeQuestions,
  type SchedulerWarningContext,
  type WorkspaceSchedulerState,
} from "./runtimeSupport.js";

type GetState = (workspaceRoot: string) => WorkspaceSchedulerState;
type WarnScheduler = (context: SchedulerWarningContext, error: unknown) => void;

export async function triggerScheduleRun(args: {
  workspaceRoot: string;
  scheduleId: string;
  nowMs: number;
  getState: GetState;
  warnScheduler: WarnScheduler;
}): Promise<void> {
  const state = args.getState(args.workspaceRoot);
  const store = state.store;
  const schedule = store.getSchedule(args.scheduleId);
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
      store.insertRun({ scheduleId: schedule.id, externalId, runAt, taskId: null, status: "queued" }, args.nowMs);
    }
    const prompt = buildEffectiveTaskPrompt(
      { workspaceRoot: args.workspaceRoot, scheduleId: schedule.id, externalId, runAt },
      schedule,
    );
    await state.queue.enqueue(
      {
        workspaceRoot: args.workspaceRoot,
        scheduleId: schedule.id,
        externalId,
        runAt,
        prompt,
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
    args.warnScheduler(
      {
        stage: "compute-next-run",
        workspaceRoot: args.workspaceRoot,
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
      args.nowMs,
    );
    return;
  }

  store.updateSchedule(schedule.id, { nextRunAt, leaseOwner: null, leaseUntil: null }, args.nowMs);
}

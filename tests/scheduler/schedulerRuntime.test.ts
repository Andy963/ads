import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SchedulerRuntime } from "../../server/scheduler/runtime.js";
import type { ScheduleSpec } from "../../server/scheduler/scheduleSpec.js";
import { ScheduleStore } from "../../server/scheduler/store.js";
import { resetDatabaseForTests } from "../../server/storage/database.js";
import { TaskStore } from "../../server/tasks/store.js";
import { getTaskNotificationRow } from "../../server/web/taskNotifications/store.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";

function buildScheduleSpec(overrides?: Partial<ScheduleSpec>): ScheduleSpec {
  const base: ScheduleSpec = {
    version: 1,
    name: "runtime-test",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    instruction: "Remind user to drink water",
    delivery: { channels: ["web"], web: { audience: "owner" }, telegram: { chatId: null } },
    policy: {
      workspaceWrite: false,
      network: "deny",
      maxDurationMs: 600000,
      maxRetries: 0,
      concurrencyKey: "schedule:{scheduleId}",
      idempotencyKeyTemplate: "sch:{scheduleId}:{runAtIso}",
    },
    compiledTask: {
      title: "Reminder",
      prompt: "Remind user to drink water.",
      expectedResultSchema: { type: "object" },
      verification: { commands: [] },
    },
    questions: [],
  };
  return {
    ...base,
    ...overrides,
    schedule: { ...base.schedule, ...(overrides?.schedule ?? {}) },
    delivery: {
      ...base.delivery,
      ...(overrides?.delivery ?? {}),
      web: { ...base.delivery.web, ...(overrides?.delivery?.web ?? {}) },
      telegram: { ...base.delivery.telegram, ...(overrides?.delivery?.telegram ?? {}) },
    },
    policy: { ...base.policy, ...(overrides?.policy ?? {}) },
    compiledTask: {
      ...base.compiledTask,
      ...(overrides?.compiledTask ?? {}),
      verification: {
        ...base.compiledTask.verification,
        ...(overrides?.compiledTask?.verification ?? {}),
      },
    },
    questions: overrides?.questions ?? base.questions,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for scheduler condition");
}

function createLoggerSpy(): {
  warns: Array<{ message: string; args: unknown[] }>;
  debugs: Array<{ message: string; args: unknown[] }>;
  infos: Array<{ message: string; args: unknown[] }>;
  logger: {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
  };
} {
  const warns: Array<{ message: string; args: unknown[] }> = [];
  const debugs: Array<{ message: string; args: unknown[] }> = [];
  const infos: Array<{ message: string; args: unknown[] }> = [];
  return {
    warns,
    debugs,
    infos,
    logger: {
      info(message: string, ...args: unknown[]) {
        infos.push({ message, args });
      },
      warn(message: string, ...args: unknown[]) {
        warns.push({ message, args });
      },
      debug(message: string, ...args: unknown[]) {
        debugs.push({ message, args });
      },
    },
  };
}

describe("scheduler/runtime-liteque", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-scheduler-runtime-"));
    fs.mkdirSync(path.join(tmpDir, ".git"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    delete process.env.TELEGRAM_ALLOWED_USERS;
    resetDatabaseForTests();
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("registers workspaces lazily and materializes scheduler state on the first due tick", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Lazy runtime materialization",
        spec: buildScheduleSpec(),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    let executions = 0;
    const runtime = new SchedulerRuntime({
      enabled: true,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => {
        executions += 1;
        return { resultSummary: "lazy-ok" };
      },
    });
    const internal = runtime as unknown as { workspaces: Set<string>; states: Map<string, unknown> };

    runtime.registerWorkspace(tmpDir);
    assert.deepEqual(Array.from(internal.workspaces), [tmpDir]);
    assert.equal(internal.states.size, 0);

    await runtime.tickWorkspace(tmpDir);
    assert.equal(internal.states.size, 1);
    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    runtime.stop();

    assert.equal(executions, 1);
  });

  it("recycles idle scheduler state and rebuilds it for later due runs without duplicate execution", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Idle recycle",
        spec: buildScheduleSpec(),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    let executions = 0;
    const runtime = new SchedulerRuntime({
      enabled: true,
      idleRecycleMs: 5,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => {
        executions += 1;
        return { resultSummary: `run-${executions}` };
      },
    });
    const internal = runtime as unknown as {
      states: Map<string, { lastTouchedAt: number; runnerPromise: Promise<void> | null }>;
    };

    runtime.registerWorkspace(tmpDir);
    await runtime.tickWorkspace(tmpDir);
    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    await waitFor(() => internal.states.get(tmpDir)?.runnerPromise == null);

    const firstState = internal.states.get(tmpDir);
    assert.ok(firstState);
    firstState!.lastTouchedAt = Date.now() - 50;

    await runtime.tickWorkspace(tmpDir);
    assert.equal(internal.states.has(tmpDir), false);

    store.updateSchedule(schedule.id, { nextRunAt: Date.now() - 1000 }, Date.now());

    await runtime.tickWorkspace(tmpDir);
    await waitFor(() => store.listRuns(schedule.id, { limit: 2 }).length === 2);
    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");

    const rebuiltState = internal.states.get(tmpDir);
    assert.ok(rebuiltState);
    assert.notEqual(rebuiltState, firstState);
    assert.equal(executions, 2);
    assert.deepEqual(
      store.listRuns(schedule.id, { limit: 10 }).map((run) => run.status),
      ["completed", "completed"],
    );

    runtime.stop();
  });

  it("executes due schedules via liteque worker and persists completed run", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Remind user to drink water",
        spec: buildScheduleSpec(),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    let executions = 0;
    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => {
        executions += 1;
        return { resultSummary: "done" };
      },
    });
    runtime.registerWorkspace(tmpDir);
    runtime.start();
    await runtime.tickWorkspace(tmpDir);

    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    runtime.stop();

    assert.equal(executions, 1);
    const run = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(run);
    assert.equal(run?.status, "completed");
    assert.equal(run?.result, "done");

    const task = new TaskStore({ workspacePath: tmpDir }).getTask(run?.taskId ?? "");
    assert.ok(task);
    assert.equal(task?.status, "completed");
  });

  it("binds scheduler telegram delivery and sends direct telegram output to explicit chat id", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_ID = "111";

    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Send jokes to TG",
        spec: buildScheduleSpec({
          delivery: { channels: ["telegram"], telegram: { chatId: "222" } },
        }),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    const fetchCalls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => ({
        resultSummary: JSON.stringify({
          status: "ok",
          summary: "sent",
          outputs: { telegram: { text: "起来活动一下" } },
        }),
      }),
    });
    runtime.registerWorkspace(tmpDir);

    try {
      runtime.start();
      await runtime.tickWorkspace(tmpDir);
      await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
      await waitFor(() => fetchCalls.length === 1);
    } finally {
      runtime.stop();
      globalThis.fetch = originalFetch;
    }

    const run = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(run?.taskId);

    const notification = getTaskNotificationRow({ taskId: run.taskId! });
    assert.ok(notification);
    assert.equal(notification?.telegramChatId, "222");
    assert.equal(notification?.status, "completed");
    assert.ok(notification?.notifiedAt != null);

    assert.equal(fetchCalls.length, 1);
    const payload = JSON.parse(fetchCalls[0]!.body) as { chat_id: string; text: string };
    assert.equal(payload.chat_id, "222");
    assert.equal(payload.text, "起来活动一下");
  });

  it("extracts scheduler telegram text from fenced json results instead of sending terminal summaries", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_ID = "111";

    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Send water reminder to TG",
        spec: buildScheduleSpec({
          delivery: { channels: ["telegram"], telegram: { chatId: "222" } },
        }),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    const fetchCalls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => ({
        resultSummary: ["提醒如下：", "```json", '{"status":"ok","summary":"sent","outputs":{"telegram":{"text":"该喝水了"}}}', "```"].join(
          "\n",
        ),
      }),
    });
    runtime.registerWorkspace(tmpDir);

    try {
      runtime.start();
      await runtime.tickWorkspace(tmpDir);
      await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
      await waitFor(() => fetchCalls.length === 1);
    } finally {
      runtime.stop();
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalls.length, 1);
    const payload = JSON.parse(fetchCalls[0]!.body) as { chat_id: string; text: string };
    assert.equal(payload.chat_id, "222");
    assert.equal(payload.text, "该喝水了");
  });

  it("marks scheduler runs with empty telegram outputs as handled without sending terminal summaries", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_ID = "111";

    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Send movement reminder only within active window",
        spec: buildScheduleSpec({
          delivery: { channels: ["telegram"], telegram: { chatId: "222" } },
        }),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    const fetchCalls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => ({
        resultSummary: JSON.stringify({
          status: "ok",
          summary: "outside active hour window",
          outputs: {},
        }),
      }),
    });
    runtime.registerWorkspace(tmpDir);

    try {
      runtime.start();
      await runtime.tickWorkspace(tmpDir);
      await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
      await waitFor(() => {
        const run = store.listRuns(schedule.id, { limit: 1 })[0];
        if (!run?.taskId) {
          return false;
        }
        return getTaskNotificationRow({ taskId: run.taskId })?.notifiedAt != null;
      });
    } finally {
      runtime.stop();
      globalThis.fetch = originalFetch;
    }

    const run = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(run?.taskId);

    const notification = getTaskNotificationRow({ taskId: run.taskId! });
    assert.ok(notification);
    assert.equal(notification?.telegramChatId, "222");
    assert.equal(notification?.status, "completed");
    assert.ok(notification?.notifiedAt != null);

    assert.equal(fetchCalls.length, 0);
  });

  it("retries worker execution and keeps one effective run per schedule window", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const retrySpec = buildScheduleSpec();
    retrySpec.policy = { ...retrySpec.policy, maxRetries: 1 };
    const schedule = store.createSchedule(
      {
        instruction: "Retry test",
        spec: retrySpec,
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    let attempts = 0;
    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient failure");
        }
        return { resultSummary: "retry-ok" };
      },
    });
    runtime.registerWorkspace(tmpDir);
    runtime.start();
    await runtime.tickWorkspace(tmpDir);

    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    runtime.stop();

    assert.equal(attempts, 2);
    const runs = store.listRuns(schedule.id, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "completed");
    assert.equal(runs[0]?.result, "retry-ok");
  });

  it("injects deterministic trigger metadata into the scheduled task prompt", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const dueRunAt = Date.now() - 1000;
    const now = dueRunAt + 1000;
    const compiledPrompt = "  Use runAtIso to decide whether the reminder should be sent for this trigger.  ";
    const schedule = store.createSchedule(
      {
        instruction: "Send movement reminder",
        spec: buildScheduleSpec({
          schedule: { timezone: "Asia/Shanghai" },
          compiledTask: {
            prompt: compiledPrompt,
          },
        }),
        enabled: true,
        nextRunAt: dueRunAt,
      },
      now,
    );

    let seenPrompt = "";
    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async ({ task }) => {
        seenPrompt = task.prompt;
        return { resultSummary: "prompt-ok" };
      },
    });
    runtime.registerWorkspace(tmpDir);
    runtime.start();
    await runtime.tickWorkspace(tmpDir);

    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    runtime.stop();

    const runAtIso = new Date(dueRunAt).toISOString();
    const externalId = `sch:${schedule.id}:${runAtIso}`;
    assert.ok(seenPrompt.includes("Scheduler runtime context:"));
    assert.ok(seenPrompt.includes(`- scheduleId: ${schedule.id}`));
    assert.ok(seenPrompt.includes(`- externalId: ${externalId}`));
    assert.ok(seenPrompt.includes(`- runAtIso: ${runAtIso}`));
    assert.ok(seenPrompt.includes(`- timezone: Asia/Shanghai`));
    assert.ok(seenPrompt.endsWith(compiledPrompt));

    const run = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(run?.taskId);
    const task = new TaskStore({ workspacePath: tmpDir }).getTask(run?.taskId ?? "");
    assert.ok(task);
    assert.equal(task?.prompt, seenPrompt);
  });

  it("freezes the queued run prompt before execution even if the schedule spec changes later", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const dueRunAt = Date.now() - 1000;
    const now = dueRunAt + 1000;
    const originalCompiledPrompt = "Use the original compiled prompt for this queued run.";
    const rewrittenCompiledPrompt = "Use the rewritten compiled prompt instead.";
    const schedule = store.createSchedule(
      {
        instruction: "Send movement reminder",
        spec: buildScheduleSpec({
          schedule: { timezone: "Asia/Shanghai" },
          compiledTask: {
            prompt: originalCompiledPrompt,
          },
        }),
        enabled: true,
        nextRunAt: dueRunAt,
      },
      now,
    );

    const queueOnlyRuntime = new SchedulerRuntime({
      enabled: false,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => ({ resultSummary: "should-not-run" }),
    });
    queueOnlyRuntime.registerWorkspace(tmpDir);
    await queueOnlyRuntime.tickWorkspace(tmpDir);
    queueOnlyRuntime.stop();

    const runAtIso = new Date(dueRunAt).toISOString();
    const externalId = `sch:${schedule.id}:${runAtIso}`;
    const queuedTask = new TaskStore({ workspacePath: tmpDir }).getTask(externalId);
    assert.ok(queuedTask);
    assert.ok(queuedTask?.prompt.includes(originalCompiledPrompt));

    const queuedSchedule = store.getSchedule(schedule.id);
    assert.ok(queuedSchedule);
    store.updateSchedule(
      schedule.id,
      {
        spec: {
          ...queuedSchedule!.spec,
          compiledTask: {
            ...queuedSchedule!.spec.compiledTask,
            prompt: rewrittenCompiledPrompt,
          },
        },
      },
      Date.now(),
    );

    let seenPrompt = "";
    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async ({ task }) => {
        seenPrompt = task.prompt;
        return { resultSummary: "prompt-frozen" };
      },
    });
    runtime.registerWorkspace(tmpDir);
    runtime.start();

    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    runtime.stop();

    assert.ok(seenPrompt.includes(originalCompiledPrompt));
    assert.ok(!seenPrompt.includes(rewrittenCompiledPrompt));
  });

  it("recovers queued liteque jobs after runtime restart", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Restart recovery",
        spec: buildScheduleSpec(),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    const runtime1 = new SchedulerRuntime({
      enabled: false,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => ({ resultSummary: "should-not-run" }),
    });
    runtime1.registerWorkspace(tmpDir);
    await runtime1.tickWorkspace(tmpDir);
    runtime1.stop();

    const queued = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(queued);
    assert.equal(queued?.status, "queued");

    let executions = 0;
    const runtime2 = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => {
        executions += 1;
        return { resultSummary: "recovered" };
      },
    });
    runtime2.registerWorkspace(tmpDir);
    runtime2.start();

    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    runtime2.stop();

    assert.equal(executions, 1);
    const completed = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(completed);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.result, "recovered");
  });

  it("normalizes nested workspace paths to one runtime state", async () => {
    const nestedWorkspace = path.join(tmpDir, "packages", "demo");
    fs.mkdirSync(nestedWorkspace, { recursive: true });

    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Nested workspace path normalization",
        spec: buildScheduleSpec(),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    let executions = 0;
    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      executeRun: async () => {
        executions += 1;
        return { resultSummary: "normalized" };
      },
    });

    runtime.registerWorkspace(nestedWorkspace);
    runtime.registerWorkspace(tmpDir);
    runtime.start();
    await runtime.tickWorkspace(nestedWorkspace);

    await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");

    assert.equal(executions, 1);
    const internal = runtime as unknown as { workspaces: Set<string>; states: Map<string, unknown> };
    assert.deepEqual(Array.from(internal.workspaces), [tmpDir]);
    assert.deepEqual(Array.from(internal.states.keys()), [tmpDir]);
    runtime.stop();
  });

  it("warns on summary persistence failure without breaking completion flow", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Summary persistence warning",
        spec: buildScheduleSpec(),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    const loggerSpy = createLoggerSpy();
    const runtime = new SchedulerRuntime({
      enabled: true,
      tickMs: 60_000,
      runnerPollMs: 20,
      runnerTimeoutSecs: 10,
      logger: loggerSpy.logger,
      executeRun: async () => ({ resultSummary: "summary-ok" }),
    });
    runtime.registerWorkspace(tmpDir);

    const internal = runtime as unknown as {
      getState: (workspaceRoot: string) => { taskStore: TaskStore };
      states: Map<string, { taskStore: TaskStore }>;
    };
    const state = internal.getState(tmpDir);

    const originalSaveContext = state.taskStore.saveContext.bind(state.taskStore);
    state.taskStore.saveContext = ((taskId, context, savedAt) => {
      void taskId;
      void context;
      void savedAt;
      throw new Error("summary write failed");
    }) as typeof state.taskStore.saveContext;

    try {
      runtime.start();
      await runtime.tickWorkspace(tmpDir);
      await waitFor(() => store.listRuns(schedule.id, { limit: 1 })[0]?.status === "completed");
    } finally {
      state.taskStore.saveContext = originalSaveContext;
      runtime.stop();
    }

    const run = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(run);
    assert.equal(run?.status, "completed");

    const task = new TaskStore({ workspacePath: tmpDir }).getTask(run?.taskId ?? "");
    assert.ok(task);
    assert.equal(task?.status, "completed");
    assert.equal(task?.result, "summary-ok");

    const warning = loggerSpy.warns.find((entry) => entry.message.includes("stage=save-summary"));
    assert.ok(warning);
    assert.ok(warning.message.includes(`workspaceRoot=${tmpDir}`));
    assert.ok(warning.message.includes(`scheduleId=${schedule.id}`));
    assert.ok(warning.message.includes(`externalId=${run?.externalId}`));
    assert.ok(warning.message.includes(`taskId=${run?.taskId}`));
    assert.ok(warning.message.includes("err=summary write failed"));
  });

  it("warns and disables schedule when cron cannot be computed", async () => {
    const store = new ScheduleStore({ workspacePath: tmpDir });
    const now = Date.now();
    const schedule = store.createSchedule(
      {
        instruction: "Invalid cron should disable schedule",
        spec: buildScheduleSpec({ schedule: { cron: "0 9 1 * *" } }),
        enabled: true,
        nextRunAt: now - 1000,
      },
      now,
    );

    const loggerSpy = createLoggerSpy();
    const runtime = new SchedulerRuntime({
      enabled: false,
      logger: loggerSpy.logger,
    });
    runtime.registerWorkspace(tmpDir);

    try {
      await runtime.tickWorkspace(tmpDir);
    } finally {
      runtime.stop();
    }

    const updated = store.getSchedule(schedule.id);
    assert.ok(updated);
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.nextRunAt, null);

    const run = store.listRuns(schedule.id, { limit: 1 })[0];
    assert.ok(run);

    const warning = loggerSpy.warns.find((entry) => entry.message.includes("stage=compute-next-run"));
    assert.ok(warning);
    assert.ok(warning.message.includes(`workspaceRoot=${tmpDir}`));
    assert.ok(warning.message.includes(`scheduleId=${schedule.id}`));
    assert.ok(warning.message.includes(`externalId=${run?.externalId}`));
    assert.ok(warning.message.includes("err=Only dom='*' and mon='*' are supported"));
  });
});

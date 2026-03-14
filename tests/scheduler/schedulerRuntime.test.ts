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

describe("scheduler/runtime-liteque", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-scheduler-runtime-"));
    fs.mkdirSync(path.join(tmpDir, ".git"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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
    runtime.stop();

    assert.equal(executions, 1);
    const internal = runtime as unknown as { workspaces: Set<string>; states: Map<string, unknown> };
    assert.deepEqual(Array.from(internal.workspaces), [tmpDir]);
    assert.deepEqual(Array.from(internal.states.keys()), [tmpDir]);
  });
});

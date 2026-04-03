import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureTaskForRun, parseSchedulerJobPayload } from "../../server/scheduler/runtimeJobLifecycle.js";
import type { WorkspaceSchedulerState } from "../../server/scheduler/runtimeSupport.js";
import type { ScheduleSpec } from "../../server/scheduler/scheduleSpec.js";
import type { StoredSchedule } from "../../server/scheduler/store.js";
import { resetDatabaseForTests } from "../../server/storage/database.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { TaskStore } from "../../server/tasks/store.js";

function buildScheduleSpec(overrides?: Partial<ScheduleSpec>): ScheduleSpec {
  const base: ScheduleSpec = {
    version: 1,
    name: "runtime-helper-test",
    enabled: true,
    schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    instruction: "Remind user to stretch",
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
      prompt: "Use the original compiled prompt.",
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

describe("scheduler/runtime helpers", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-scheduler-runtime-helpers-"));
    fs.mkdirSync(path.join(tmpDir, ".git"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
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

  it("normalizes scheduler job payloads to the workspace root and rejects invalid shapes", () => {
    const nestedWorkspace = path.join(tmpDir, "packages", "demo");
    fs.mkdirSync(nestedWorkspace, { recursive: true });

    assert.deepEqual(
      parseSchedulerJobPayload({
        workspaceRoot: nestedWorkspace,
        scheduleId: "schedule-1",
        externalId: "run-1",
        runAt: 1234.9,
      }),
      {
        workspaceRoot: tmpDir,
        scheduleId: "schedule-1",
        externalId: "run-1",
        runAt: 1234,
      },
    );

    assert.equal(
      parseSchedulerJobPayload({ workspaceRoot: nestedWorkspace, scheduleId: "", externalId: "run-1", runAt: 1 }),
      null,
    );
    assert.equal(parseSchedulerJobPayload({ workspaceRoot: nestedWorkspace, scheduleId: "s", externalId: "", runAt: 1 }), null);
    assert.equal(parseSchedulerJobPayload({ workspaceRoot: nestedWorkspace, scheduleId: "s", externalId: "e", runAt: Number.NaN }), null);
    assert.equal(parseSchedulerJobPayload(null), null);
  });

  it("reuses an existing scheduled task so later schedule edits do not rewrite the frozen prompt", () => {
    const taskStore = new TaskStore({ workspacePath: tmpDir });
    const getState = () => ({ taskStore } as unknown as WorkspaceSchedulerState);
    const payload = {
      workspaceRoot: tmpDir,
      scheduleId: "schedule-1",
      externalId: "sch:schedule-1:2026-01-01T09:00:00.000Z",
      runAt: Date.UTC(2026, 0, 1, 9, 0, 0),
    };
    const baseSchedule: StoredSchedule = {
      id: "schedule-1",
      instruction: "Stretch reminder",
      spec: buildScheduleSpec({ compiledTask: { prompt: "Use the original compiled prompt." } }),
      enabled: true,
      nextRunAt: payload.runAt,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: 0,
      updatedAt: 0,
    };

    const first = ensureTaskForRun({
      getState,
      payload,
      schedule: baseSchedule,
      now: 1000,
    });

    const updatedSchedule: StoredSchedule = {
      ...baseSchedule,
      spec: buildScheduleSpec({ compiledTask: { prompt: "Use the rewritten compiled prompt." } }),
    };
    const second = ensureTaskForRun({
      getState,
      payload,
      schedule: updatedSchedule,
      now: 2000,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.prompt, first.prompt);
    assert.ok(first.prompt.includes("Scheduler runtime context:"));
    assert.ok(first.prompt.includes("Use the original compiled prompt."));
    assert.ok(!second.prompt.includes("Use the rewritten compiled prompt."));
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { computeNextCronRunAt } from "../../src/scheduler/cron.js";
import { ScheduleStore } from "../../src/scheduler/store.js";
import type { ScheduleSpec } from "../../src/scheduler/scheduleSpec.js";
import { TaskStore } from "../../src/tasks/store.js";

describe("scheduler/store", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-scheduler-"));
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

  it("creates schedules and enforces run external_id uniqueness", () => {
    const afterMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = computeNextCronRunAt({ cron: "0 9 * * *", timezone: "UTC", afterMs });
    assert.equal(new Date(next).toISOString(), "2026-01-01T09:00:00.000Z");

    const spec: ScheduleSpec = {
      version: 1,
      name: "daily-sample",
      enabled: true,
      schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
      instruction: "Every day at 09:00 UTC, produce a sample report.",
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
        title: "Produce a sample report",
        prompt: "Return a single JSON object.",
        expectedResultSchema: { type: "object" },
        verification: { commands: [] },
      },
      questions: [],
    };

    const store = new ScheduleStore({ workspacePath: tmpDir });
    const schedule = store.createSchedule(
      { instruction: spec.instruction, spec, enabled: true, nextRunAt: next },
      1234,
    );
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.nextRunAt, next);

    const runAtIso = new Date(next).toISOString();
    const externalId = `sch:${schedule.id}:${runAtIso}`;

    const taskStore = new TaskStore({ workspacePath: tmpDir });
    taskStore.createTask(
      {
        id: externalId,
        title: "Sample",
        prompt: "Return JSON.",
        model: "auto",
        inheritContext: false,
        createdBy: "test",
      },
      1500,
      { status: "pending" },
    );

    const first = store.insertRun(
      { scheduleId: schedule.id, externalId, runAt: next, taskId: externalId, status: "queued" },
      2000,
    );
    assert.equal(first.inserted, true);

    const second = store.insertRun(
      { scheduleId: schedule.id, externalId, runAt: next, taskId: externalId, status: "queued" },
      2001,
    );
    assert.equal(second.inserted, false);

    const fetched = store.getRunByExternalId(externalId);
    assert.ok(fetched);
    assert.equal(fetched?.externalId, externalId);
  });
});

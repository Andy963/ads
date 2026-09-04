import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseSchedulerJobPayload } from "../../server/scheduler/runtimeJobLifecycle.js";
import { resetDatabaseForTests } from "../../server/storage/database.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";

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
        prompt: "frozen prompt text",
      }),
      {
        workspaceRoot: tmpDir,
        scheduleId: "schedule-1",
        externalId: "run-1",
        runAt: 1234,
        prompt: "frozen prompt text",
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
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";
import type { PlanStepInput, Task } from "../../src/tasks/types.js";
import { OrchestratorTaskExecutor } from "../../src/tasks/executor.js";
import { AsyncLock } from "../../src/utils/asyncLock.js";

describe("tasks/executor lock", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-exec-lock-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
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

  it("holds the lock across the entire task execution", async () => {
    const store = new TaskStore();
    const lock = new AsyncLock();

    const step1Gate = Promise.withResolvers<void>();
    const step2Gate = Promise.withResolvers<void>();
    const called: string[] = [];

    const orchestrator = {
      setModel() {},
      onEvent() {
        return () => {};
      },
      async invokeAgent(_: string, __: string) {
        called.push("invoke:start");
        const idx = called.filter((x) => x === "invoke:start").length;
        if (idx === 1) {
          await step1Gate.promise;
        } else {
          await step2Gate.promise;
        }
        return { response: `ok:${idx}` };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      defaultModel: "mock",
      lock,
    });

    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;
    const plan: PlanStepInput[] = [
      { stepNumber: 1, title: "S1", description: "" },
      { stepNumber: 2, title: "S2", description: "" },
    ];

    let otherRan = false;
    const run = executor.execute(task, plan, {});

    // Let the executor reach step 1.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lock.isBusy(), true);

    const other = lock.runExclusive(async () => {
      otherRan = true;
    });

    step1Gate.resolve();

    // If the lock is held across the entire execution, "other" should still be blocked even after step 1 finishes.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(otherRan, false);

    step2Gate.resolve();
    await run;
    await other;

    assert.equal(otherRan, true);
    assert.deepEqual(
      called.filter((x) => x === "invoke:start"),
      ["invoke:start", "invoke:start"],
    );
  });
});

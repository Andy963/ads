import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/types.js";
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

    const runGate = Promise.withResolvers<void>();
    const called: string[] = [];

    const orchestrator = {
      setModel() {},
      onEvent() {
        return () => {};
      },
      async invokeAgent(_: string, __: string) {
        called.push("invoke:start");
        await runGate.promise;
        return { response: "ok" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      defaultModel: "mock",
      lock,
    });

    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;

    let otherRan = false;
    const run = executor.execute(task, {});

    // Let the executor enter the critical section.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lock.isBusy(), true);

    const other = lock.runExclusive(async () => {
      otherRan = true;
    });

    // If the lock is held across the entire execution, "other" should still be blocked while the task is running.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(otherRan, false);

    runGate.resolve();
    await run;
    await other;

    assert.equal(otherRan, true);
    assert.deepEqual(
      called.filter((x) => x === "invoke:start"),
      ["invoke:start"],
    );
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";
import { TaskQueue } from "../../src/tasks/queue.js";
import type { TaskExecutor } from "../../src/tasks/executor.js";
import type { Task } from "../../src/tasks/types.js";

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

describe("tasks/taskQueue", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-queue-"));
    dbPath = path.join(tmpDir, "tasks.db");
    process.env.ADS_DATABASE_PATH = dbPath;
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

  it("should execute a pending task and mark completed", async () => {
    const store = new TaskStore();
    const executor: TaskExecutor = {
      async execute(task: Task): Promise<{ resultSummary?: string }> {
        void task;
        return { resultSummary: "ok" };
      },
    };
    const queue = new TaskQueue({ store, executor });
    void queue.start();

    const task = store.createTask({ title: "T", prompt: "P" });
    queue.notifyNewTask();

    await waitFor(() => store.getTask(task.id)?.status === "completed");
    const finalTask = store.getTask(task.id);
    assert.ok(finalTask);
    assert.equal(finalTask.status, "completed");
    assert.equal(finalTask.result, "ok");

    queue.stop();
  });
});

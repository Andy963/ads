import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { TaskStore } from "../../server/tasks/store.js";
import { TaskQueue } from "../../server/tasks/queue.js";
import {
  TASK_UPSTREAM_RETRY_BASE_DELAY_ENV,
  TASK_UPSTREAM_RETRY_MAX_DELAY_ENV,
} from "../../server/tasks/queue.js";
import { TransientModelRetryExhaustedError } from "../../server/agents/adapters/transientModelRetry.js";
import type { TaskExecutor } from "../../server/tasks/executor.js";
import type { Task } from "../../server/tasks/types.js";

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

  it("should persist cooldown before retrying an exhausted upstream failure", async () => {
    process.env[TASK_UPSTREAM_RETRY_BASE_DELAY_ENV] = "10000";
    process.env[TASK_UPSTREAM_RETRY_MAX_DELAY_ENV] = "60000";
    const store = new TaskStore();
    let executions = 0;
    const executor: TaskExecutor = {
      async execute(): Promise<{ resultSummary?: string }> {
        executions += 1;
        throw new TransientModelRetryExhaustedError("HTTP 429 Too Many Requests", { attempts: 3 });
      },
    };
    const queue = new TaskQueue({ store, executor });
    void queue.start();

    const task = store.createTask({ title: "T", prompt: "P", maxRetries: 2 });
    queue.notifyNewTask();

    await waitFor(() => store.getTask(task.id)?.retryCount === 1);
    const pending = store.getTask(task.id);
    assert.ok(pending);
    assert.equal(pending.status, "pending");
    assert.ok((pending.nextAttemptAt ?? 0) > Date.now());

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(executions, 1);

    queue.stop();
  });
});

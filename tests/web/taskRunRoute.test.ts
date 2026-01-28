import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";
import { TaskQueue } from "../../src/tasks/queue.js";
import type { TaskPlanner } from "../../src/tasks/planner.js";
import type { TaskExecutor } from "../../src/tasks/executor.js";
import type { PlanStepInput, Task } from "../../src/tasks/types.js";
import { TaskRunController } from "../../src/web/taskRunController.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "../../src/web/api/taskRun.js";

describe("web/api/taskRun", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-run-route-"));
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

  it("should match /api/tasks/:id/run", () => {
    assert.equal(matchSingleTaskRunPath("/api/tasks/abc/run"), "abc");
    assert.equal(matchSingleTaskRunPath("/api/tasks/abc/run/"), null);
    assert.equal(matchSingleTaskRunPath("/api/tasks/abc"), null);
  });

  it("should reject when task queue is disabled", () => {
    const store = new TaskStore();
    const planner: TaskPlanner = {
      async generatePlan(task: Task): Promise<PlanStepInput[]> {
        void task;
        return [{ stepNumber: 1, title: "Do", description: "" }];
      },
    };
    const executor: TaskExecutor = {
      async execute(task: Task): Promise<{ resultSummary?: string }> {
        return { resultSummary: `done:${task.id}` };
      },
    };
    const queue = new TaskQueue({ store, planner, executor });
    const controller = new TaskRunController();
    const ctx = { taskStore: store, taskQueue: queue, queueRunning: false };

    const task = store.createTask({ title: "T", prompt: "P" });
    const result = handleSingleTaskRun({
      taskQueueAvailable: false,
      controller,
      ctx,
      taskId: task.id,
      now: Date.now(),
    });
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { error: "Task queue disabled" });
  });
});


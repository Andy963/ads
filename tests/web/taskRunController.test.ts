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

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

describe("web/taskRunController", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-run-"));
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

  it("should run only the requested task and pause the queue afterwards", async () => {
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
    queue.pause("manual");
    void queue.start();

    const t1 = store.createTask({ title: "T1", prompt: "P1" });
    const t2 = store.createTask({ title: "T2", prompt: "P2" });

    const controller = new TaskRunController();
    const ctx = { taskStore: store, taskQueue: queue, queueRunning: false };

    queue.on("task:completed", ({ task }) => {
      controller.onTaskTerminal(ctx, task.id);
    });
    queue.on("task:cancelled", ({ task }) => {
      controller.onTaskTerminal(ctx, task.id);
    });
    queue.on("task:failed", ({ task }) => {
      if (task.status === "failed") {
        controller.onTaskTerminal(ctx, task.id);
      }
    });

    const res = controller.requestSingleTaskRun(ctx, t2.id, Date.now());
    assert.equal(res.status, 200);
    assert.equal(ctx.queueRunning, true);

    await waitFor(() => store.getTask(t2.id)?.status === "completed" && ctx.queueRunning === false);

    const final2 = store.getTask(t2.id);
    assert.ok(final2);
    assert.equal(final2.status, "completed");
    assert.equal(final2.result, `done:${t2.id}`);

    const final1 = store.getTask(t1.id);
    assert.ok(final1);
    assert.equal(final1.status, "pending");
    assert.equal(final1.result, null);

    // Give the queue time; it should remain paused and never start t1.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.getTask(t1.id)?.status, "pending");

    const audit = store.getMessages(t2.id).filter((m) => m.messageType === "audit");
    assert.equal(audit.length, 1);
  });

  it("should be idempotent while the same single-task run is in progress", async () => {
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
    queue.pause("manual");
    void queue.start();

    const task = store.createTask({ title: "T", prompt: "P" });
    const controller = new TaskRunController();
    const ctx = { taskStore: store, taskQueue: queue, queueRunning: false };

    queue.on("task:completed", ({ task: completed }) => {
      controller.onTaskTerminal(ctx, completed.id);
    });

    const first = controller.requestSingleTaskRun(ctx, task.id, Date.now());
    assert.equal(first.status, 200);

    const second = controller.requestSingleTaskRun(ctx, task.id, Date.now());
    assert.equal(second.status, 202);

    const audit = store.getMessages(task.id).filter((m) => m.messageType === "audit");
    assert.equal(audit.length, 1);
  });

  it("should allow running a cancelled task via single-task run", async () => {
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
    queue.pause("manual");
    void queue.start();

    const controller = new TaskRunController();
    const ctx = { taskStore: store, taskQueue: queue, queueRunning: false };

    queue.on("task:completed", ({ task }) => {
      controller.onTaskTerminal(ctx, task.id);
    });
    queue.on("task:cancelled", ({ task }) => {
      controller.onTaskTerminal(ctx, task.id);
    });
    queue.on("task:failed", ({ task }) => {
      if (task.status === "failed") {
        controller.onTaskTerminal(ctx, task.id);
      }
    });

    const task = store.createTask({ title: "T", prompt: "P" });
    store.updateTask(task.id, { status: "cancelled", error: "cancelled", retryCount: 2 }, Date.now());
    assert.equal(store.getTask(task.id)?.status, "cancelled");

    const res = controller.requestSingleTaskRun(ctx, task.id, Date.now());
    assert.equal(res.status, 200);
    assert.equal(store.getTask(task.id)?.retryCount, 0);

    await waitFor(() => store.getTask(task.id)?.status === "completed" && ctx.queueRunning === false);

    const final = store.getTask(task.id);
    assert.ok(final);
    assert.equal(final.status, "completed");
    assert.equal(final.result, `done:${task.id}`);
  });
});

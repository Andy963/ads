import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";
import { TaskQueue } from "../../src/tasks/queue.js";
import type { TaskExecutor } from "../../src/tasks/executor.js";
import type { Task } from "../../src/tasks/types.js";
import { TaskRunController } from "../../src/web/taskRunController.js";
import { broadcastTaskStart } from "../../src/web/taskStartBroadcast.js";

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

describe("web/taskStartBroadcast", () => {
  it("broadcasts task:started before the user message (already injected)", () => {
    const events: Array<{ event?: string; data?: unknown }> = [];
    const history: Array<{ role: string; text: string; ts: number; kind?: string }> = [];
    const metrics: Array<{ name: string; event?: { reason?: string } }> = [];
    const ts = Date.parse("2026-01-01T00:00:00.000Z");

    broadcastTaskStart({
      task: { id: "t-1", prompt: "  Hello \n" },
      ts,
      markPromptInjected: () => false,
      recordHistory: (entry) => history.push(entry),
      recordMetric: (name, event) => metrics.push({ name, event }),
      broadcast: (payload) => events.push(payload as { event?: string; data?: unknown }),
    });

    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "task:started");
    assert.equal(events[1]?.event, "message");
    assert.deepEqual(events[1]?.data, { taskId: "t-1", role: "user", content: "Hello" });

    assert.equal(history.length, 1);
    assert.equal(history[0]?.role, "user");
    assert.equal(history[0]?.text, "Hello");

    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.name, "PROMPT_INJECTED");
    assert.equal(metrics[0]?.event?.reason, "already_marked");
  });

  it("broadcasts a placeholder when prompt is empty", () => {
    const events: Array<{ event?: string; data?: unknown }> = [];
    const history: Array<{ role: string; text: string; ts: number; kind?: string }> = [];
    const metrics: Array<{ name: string; event?: { reason?: string } }> = [];
    const ts = Date.parse("2026-01-01T00:00:00.000Z");

    broadcastTaskStart({
      task: { id: "t-1", title: "My task", prompt: "   " },
      ts,
      markPromptInjected: () => true,
      recordHistory: (entry) => history.push(entry),
      recordMetric: (name, event) => metrics.push({ name, event }),
      broadcast: (payload) => events.push(payload as { event?: string; data?: unknown }),
    });

    const placeholder = "Task My task (t-1) started at 2026-01-01T00:00:00.000Z (no prompt)";
    assert.equal(events[0]?.event, "task:started");
    assert.equal(events[1]?.event, "message");
    assert.deepEqual(events[1]?.data, { taskId: "t-1", role: "user", content: placeholder });
    assert.equal(history[0]?.text, placeholder);
    assert.equal(metrics[0]?.event?.reason, "empty_prompt");
  });

  it("records failed when markPromptInjected throws", () => {
    const metrics: Array<{ name: string; event?: { reason?: string } }> = [];
    const ts = Date.parse("2026-01-01T00:00:00.000Z");

    broadcastTaskStart({
      task: { id: "t-1", prompt: "P" },
      ts,
      markPromptInjected: () => {
        throw new Error("boom");
      },
      recordHistory: () => {},
      recordMetric: (name, event) => metrics.push({ name, event }),
      broadcast: () => {},
    });

    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.name, "PROMPT_INJECTED");
    assert.equal(metrics[0]?.event?.reason, "failed");
  });
});

describe("web/taskStartBroadcast integration", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-start-broadcast-"));
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

  it("broadcasts prompt on single-task run start even when prompt was injected before", async () => {
    const store = new TaskStore();
    const executor: TaskExecutor = {
      async execute(task: Task): Promise<{ resultSummary?: string }> {
        return { resultSummary: `done:${task.id}` };
      },
    };
    const queue = new TaskQueue({ store, executor });
    queue.pause("manual");
    void queue.start();

    const task = store.createTask({ title: "T", prompt: "P" });
    store.markPromptInjected(task.id, 123);

    const controller = new TaskRunController();
    const ctx = { taskStore: store, taskQueue: queue, queueRunning: false };

    const broadcasted: Array<{ event: string; data: unknown }> = [];
    const history: Array<{ role: string; text: string }> = [];
    const metrics: Array<{ name: string; reason?: string }> = [];

    queue.on("task:started", ({ task: started }) => {
      const ts = Date.now();
      broadcastTaskStart({
        task: started,
        ts,
        markPromptInjected: (taskId: string, now: number) => store.markPromptInjected(taskId, now),
        recordHistory: (entry) => history.push({ role: entry.role, text: entry.text }),
        recordMetric: (name, event) => metrics.push({ name, reason: event?.reason }),
        broadcast: (payload) => {
          const msg = payload as { event?: string; data?: unknown };
          if (msg.event && msg.data) broadcasted.push({ event: msg.event, data: msg.data });
        },
      });
    });

    queue.on("task:completed", ({ task: completed }) => {
      controller.onTaskTerminal(ctx, completed.id);
      broadcasted.push({ event: "task:completed", data: completed });
    });

    const res = controller.requestSingleTaskRun(ctx, task.id, Date.now());
    assert.equal(res.status, 200);

    await waitFor(() => store.getTask(task.id)?.status === "completed");

    assert.ok(broadcasted.length >= 3);
    assert.equal(broadcasted[0]?.event, "task:started");
    assert.equal(broadcasted[1]?.event, "message");
    assert.deepEqual(broadcasted[1]?.data, { taskId: task.id, role: "user", content: "P" });
    assert.equal(broadcasted[broadcasted.length - 1]?.event, "task:completed");

    assert.equal(history[0]?.text, "P");
    assert.equal(metrics[0]?.name, "PROMPT_INJECTED");
    assert.equal(metrics[0]?.reason, "already_marked");
  });
});

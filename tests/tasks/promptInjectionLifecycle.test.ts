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

type MetricName =
  | "TASK_ADDED"
  | "TASK_STARTED"
  | "PROMPT_INJECTED"
  | "TASK_COMPLETED"
  | "INJECTION_SKIPPED";

type MetricEvent = { name: MetricName; taskId?: string };

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
}

describe("tasks/promptInjectionLifecycle", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-prompt-inject-"));
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

  it("should inject only on pending->running start, exactly once per task, and never on add/complete", async () => {
    const store = new TaskStore();

    let unblockFirst: (() => void) | null = null;
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });

    const executor: TaskExecutor = {
      async execute(task: Task): Promise<{ resultSummary?: string }> {
        if (task.title === "T1") {
          await firstBlocked;
          return { resultSummary: "done-1" };
        }
        return { resultSummary: "done-2" };
      },
    };

    const metrics: Record<MetricName, number> = {
      TASK_ADDED: 0,
      TASK_STARTED: 0,
      PROMPT_INJECTED: 0,
      TASK_COMPLETED: 0,
      INJECTION_SKIPPED: 0,
    };
    const events: MetricEvent[] = [];
    const startedTaskIds = new Set<string>();

    const record = (name: MetricName, taskId?: string) => {
      metrics[name] += 1;
      events.push({ name, taskId });
    };

    const injectedMessages: Array<{ taskId: string; role: string; content: string }> = [];
    const tryInject = (task: Task) => {
      const now = Date.now();
      if (!startedTaskIds.has(task.id)) {
        startedTaskIds.add(task.id);
        record("TASK_STARTED", task.id);
      } else {
        record("INJECTION_SKIPPED", task.id);
      }
      const prompt = String(task.prompt ?? "").trim();
      if (!prompt) {
        record("INJECTION_SKIPPED", task.id);
        return;
      }
      const allowed = store.markPromptInjected(task.id, now);
      if (!allowed) {
        record("INJECTION_SKIPPED", task.id);
        return;
      }
      injectedMessages.push({ taskId: task.id, role: "user", content: prompt });
      record("PROMPT_INJECTED", task.id);
    };

    const queue = new TaskQueue({ store, executor });
    queue.on("task:started", ({ task }) => tryInject(task));
    let pausedAfterFirstComplete = false;
    queue.on("task:completed", ({ task }) => {
      record("TASK_COMPLETED", task.id);
      if (!pausedAfterFirstComplete) {
        pausedAfterFirstComplete = true;
        queue.pause("test");
      }
    });
    void queue.start();

    // ① Idle addTask -> no injection
    const t1 = store.createTask({ title: "T1", prompt: "P1" });
    record("TASK_ADDED", t1.id);
    assert.equal(injectedMessages.length, 0);

    // ② start the task -> inject once
    queue.notifyNewTask();
    await waitFor(() => metrics.PROMPT_INJECTED === 1);
    assert.equal(injectedMessages.length, 1);
    assert.equal(injectedMessages[0]?.content, "P1");

    // Duplicate start should be deduped.
    tryInject(t1);
    assert.equal(metrics.PROMPT_INJECTED, 1);
    assert.ok(metrics.INJECTION_SKIPPED >= 1);

    // ③ running addTask -> should not inject
    const t2 = store.createTask({ title: "T2", prompt: "P2" });
    record("TASK_ADDED", t2.id);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(injectedMessages.length, 1);

    // ④ complete current task -> should not inject the next one "on completion"
    assert.ok(unblockFirst);
    unblockFirst();
    await waitFor(() => store.getTask(t1.id)?.status === "completed");
    assert.equal(injectedMessages.length, 1);

    // ⑤ start next task -> inject once
    queue.resume();
    queue.notifyNewTask();
    await waitFor(() => metrics.PROMPT_INJECTED === 2);
    assert.equal(injectedMessages.length, 2);
    assert.equal(injectedMessages[1]?.content, "P2");

    // Assertions:
    // - prompt injection count equals started count (for tasks with non-empty prompt).
    assert.equal(metrics.PROMPT_INJECTED, metrics.TASK_STARTED);

    // - no injection earlier than start for the same task.
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.name !== "PROMPT_INJECTED" || !e.taskId) continue;
      const startedIndex = events.findIndex((x) => x.name === "TASK_STARTED" && x.taskId === e.taskId);
      assert.ok(startedIndex >= 0);
      assert.ok(startedIndex < i);
    }

    queue.stop();
  });
});

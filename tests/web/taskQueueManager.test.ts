import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTaskQueueManager } from "../../server/web/server/taskQueue/manager.js";
import type { TaskQueueContext } from "../../server/web/server/taskQueue/manager.js";

describe("web/taskQueue manager", () => {
  let tmpDir: string;
  let createdContexts: TaskQueueContext[];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-queue-manager-"));
    createdContexts = [];
    process.env.ADS_TASK_QUEUE_SESSION_TIMEOUT_MS = "0";
    process.env.ADS_TASK_QUEUE_SESSION_CLEANUP_INTERVAL_MS = "0";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const ctx of createdContexts) {
      try {
        ctx.taskQueue.stop();
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createManager(options?: {
    allowedDirs?: string[];
    available?: boolean;
    autoStart?: boolean;
  }) {
    const broadcasts: unknown[] = [];
    const histories: Array<{ sessionId: string; entry: { role: string; text: string; ts: number; kind?: string } }> = [];
    const manager = createTaskQueueManager({
      workspaceRoot: tmpDir,
      allowedDirs: options?.allowedDirs ?? [tmpDir],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: options?.available ?? false,
      autoStart: options?.autoStart ?? false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: (_sessionId, payload) => {
        broadcasts.push(payload);
      },
      recordToSessionHistories: (sessionId, entry) => {
        histories.push({ sessionId, entry });
      },
    });
    return { manager, broadcasts, histories };
  }

  it("resolves nested workspace paths to the shared workspace root", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const nestedDir = path.join(tmpDir, "packages", "worker");
    fs.mkdirSync(nestedDir, { recursive: true });

    const { manager } = createManager({ allowedDirs: [tmpDir] });
    const resolved = manager.resolveTaskWorkspaceRoot(
      new URL(`http://localhost/api/task-queue/status?workspace=${encodeURIComponent(nestedDir)}`),
    );

    assert.equal(resolved, path.resolve(tmpDir));
  });

  it("rejects nested workspace paths when the detected workspace root is outside the allow list", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const allowedRoot = path.join(tmpDir, "sandbox");
    const nestedDir = path.join(allowedRoot, "workspace");
    fs.mkdirSync(nestedDir, { recursive: true });

    const { manager } = createManager({ allowedDirs: [allowedRoot] });

    assert.throws(
      () => manager.resolveTaskWorkspaceRoot(new URL(`http://localhost/api/task-queue/status?workspace=${encodeURIComponent(nestedDir)}`)),
      /Workspace is not allowed/,
    );
  });

  it("promotes only tasks admitted to the current all-mode run", () => {
    const { manager, broadcasts } = createManager();
    const ctx = manager.ensureTaskContext(tmpDir);
    createdContexts.push(ctx);

    const admittedTask = ctx.taskStore.createTask({ title: "Admitted", prompt: "Do work", model: "auto" }, Date.now(), {
      status: "queued",
    });
    ctx.runController.setModeAll([admittedTask.id]);
    ctx.queueRunning = true;
    const lateTask = ctx.taskStore.createTask({ title: "Late", prompt: "Do later", model: "auto" }, Date.now(), {
      status: "queued",
    });

    manager.promoteQueuedTasksToPending(ctx);

    assert.equal(ctx.taskStore.getTask(admittedTask.id)?.status, "pending");
    assert.equal(ctx.taskStore.getTask(lateTask.id)?.status, "queued");
    assert.ok(
      broadcasts.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { event?: string; data?: { id?: string } }).event === "task:updated" &&
          (payload as { data?: { id?: string } }).data?.id === admittedTask.id,
      ),
    );
  });

  it("handles a large admission snapshot without exceeding sqlite parameter limits", () => {
    const { manager } = createManager();
    const ctx = manager.ensureTaskContext(tmpDir);
    createdContexts.push(ctx);

    const admittedIds: string[] = [];
    for (let index = 0; index < 901; index += 1) {
      const task = ctx.taskStore.createTask(
        { title: `Admitted ${index}`, prompt: "Do work", model: "auto" },
        Date.now(),
        { status: "queued" },
      );
      admittedIds.push(task.id);
    }
    const lateTask = ctx.taskStore.createTask(
      { title: "Late", prompt: "Do later", model: "auto" },
      Date.now(),
      { status: "queued" },
    );
    ctx.runController.setModeAll(admittedIds);
    ctx.queueRunning = true;

    manager.promoteQueuedTasksToPending(ctx);

    assert.equal(ctx.taskStore.listTasks({ status: "queued", limit: 10 }).some((task) => task.id === lateTask.id), true);
    assert.equal(ctx.taskStore.listTasks({ status: "pending", limit: 1000 }).length, 901);
  });
});

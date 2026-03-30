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
    reviewSessionManager?: object;
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
      reviewSessionManager: options?.reviewSessionManager as any,
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

  it("promotes queued tasks through the manager runtime wiring", () => {
    const { manager, broadcasts } = createManager();
    const ctx = manager.ensureTaskContext(tmpDir);
    createdContexts.push(ctx);
    ctx.queueRunning = true;

    const task = ctx.taskStore.createTask({ title: "Queued", prompt: "Do work", model: "auto" }, Date.now(), {
      status: "queued",
    });

    manager.promoteQueuedTasksToPending(ctx);

    assert.equal(ctx.taskStore.getTask(task.id)?.status, "pending");
    assert.ok(
      broadcasts.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { event?: string; data?: { id?: string } }).event === "task:updated" &&
          (payload as { data?: { id?: string } }).data?.id === task.id,
      ),
    );
  });

  it("fails review-required tasks closed when runtime review enqueue wiring cannot build a snapshot", () => {
    const { manager, broadcasts } = createManager({ reviewSessionManager: {} });
    const ctx = manager.ensureTaskContext(tmpDir);
    createdContexts.push(ctx);

    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "Needs review", prompt: "Do work", model: "auto", reviewRequired: true },
      now,
      { status: "completed" },
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot: tmpDir,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now,
    );
    const completed = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done" }, now);

    ctx.taskQueue.emit("task:completed", { task: completed });

    const failedTask = ctx.taskStore.getTask(task.id);
    const failedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(failedTask?.status, "failed");
    assert.equal(failedTask?.reviewStatus, "failed");
    assert.equal(failedTask?.reviewConclusion, "review_snapshot_patch_missing");
    assert.equal(failedRun?.status, "failed");
    assert.equal(failedRun?.captureStatus, "failed");
    assert.equal(failedRun?.applyStatus, "failed");
    assert.ok(
      broadcasts.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { event?: string; data?: { id?: string; reviewStatus?: string } }).event === "task:updated" &&
          (payload as { data?: { id?: string; reviewStatus?: string } }).data?.id === task.id &&
          (payload as { data?: { reviewStatus?: string } }).data?.reviewStatus === "failed",
      ),
    );
  });
});


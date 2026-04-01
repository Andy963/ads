import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { createTaskQueueManager } from "../../server/web/server/taskQueue/manager.js";
import {
  createLazyObject,
  createWebLaneResources,
  inspectLazyObject,
} from "../../server/web/server/start/webLaneResources.js";

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function destroySessionManagerIfMaterialized(sessionManager: { destroy: () => void }): void {
  const state = inspectLazyObject(sessionManager);
  if (state && !state.materialized) {
    return;
  }
  sessionManager.destroy();
}

describe("web lazy planner/reviewer lanes", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-lazy-lanes-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-lazy-workspace-"));
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    process.env.ADS_TASK_QUEUE_SESSION_TIMEOUT_MS = "0";
    process.env.ADS_TASK_QUEUE_SESSION_CLEANUP_INTERVAL_MS = "0";
    process.env.ADS_CLAUDE_ENABLED = "0";
    process.env.ADS_GEMINI_ENABLED = "0";
    resetStateDatabaseForTests();
  });

  afterEach(async () => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("keeps non-worker lanes cold until planner first use and then reuses the initialized runtime", async () => {
    const lanes = createWebLaneResources({
      stateDbPath: process.env.ADS_STATE_DB_PATH!,
      sessionTimeoutMs: 0,
      sessionCleanupIntervalMs: 0,
      plannerCodexModel: "test-model",
      reviewerCodexModel: "test-model",
    });
    try {
      assert.deepEqual(lanes.planner.inspectMaterialization(), {
        threadStorage: { materialized: false, materializeCount: 0 },
        historyStore: { materialized: false, materializeCount: 0 },
        sessionManager: { materialized: false, materializeCount: 0 },
        workspaceLockPool: { materialized: false, materializeCount: 0 },
      });
      assert.deepEqual(lanes.reviewer.inspectMaterialization(), {
        threadStorage: { materialized: false, materializeCount: 0 },
        historyStore: { materialized: false, materializeCount: 0 },
        sessionManager: { materialized: false, materializeCount: 0 },
        workspaceLockPool: { materialized: false, materializeCount: 0 },
      });

      const firstOrchestrator = lanes.planner.sessionManager.getOrCreate(123, workspaceRoot, false);
      assert.equal(firstOrchestrator.status().streaming, true);
      assert.equal(lanes.planner.historyStore.add("planner::session", { role: "user", text: "/pwd", ts: Date.now() }), true);
      const firstLock = lanes.planner.getWorkspaceLock(workspaceRoot);
      await firstLock.runExclusive(() => "ok");

      assert.deepEqual(lanes.planner.inspectMaterialization(), {
        threadStorage: { materialized: true, materializeCount: 1 },
        historyStore: { materialized: true, materializeCount: 1 },
        sessionManager: { materialized: true, materializeCount: 1 },
        workspaceLockPool: { materialized: true, materializeCount: 1 },
      });
      assert.deepEqual(lanes.reviewer.inspectMaterialization(), {
        threadStorage: { materialized: false, materializeCount: 0 },
        historyStore: { materialized: false, materializeCount: 0 },
        sessionManager: { materialized: false, materializeCount: 0 },
        workspaceLockPool: { materialized: false, materializeCount: 0 },
      });

      const secondOrchestrator = lanes.planner.sessionManager.getOrCreate(123, workspaceRoot, false);
      assert.equal(secondOrchestrator, firstOrchestrator);
      const secondLock = lanes.planner.getWorkspaceLock(workspaceRoot);
      assert.equal(secondLock, firstLock);
      assert.deepEqual(lanes.planner.inspectMaterialization(), {
        threadStorage: { materialized: true, materializeCount: 1 },
        historyStore: { materialized: true, materializeCount: 1 },
        sessionManager: { materialized: true, materializeCount: 1 },
        workspaceLockPool: { materialized: true, materializeCount: 1 },
      });
    } finally {
      lanes.worker.sessionManager.destroy();
      destroySessionManagerIfMaterialized(lanes.planner.sessionManager);
      destroySessionManagerIfMaterialized(lanes.reviewer.sessionManager);
    }
  });

  it("fails isolated-task auto review when no dedicated worktree was persisted", async () => {
    const reviewPrompts: string[] = [];
    const reviewerSessionManager = createLazyObject(
      () =>
        ({
          dropSession: () => {},
          getOrCreate: () => ({
            setWorkingDirectory: () => {},
            status: () => ({ ready: true, streaming: false }),
            getActiveAgentId: () => "codex",
            invokeAgent: async (_agentId: string, prompt: string) => {
              reviewPrompts.push(prompt);
              return { response: JSON.stringify({ verdict: "passed", conclusion: "looks good" }) };
            },
          }),
        }) as any,
    );
    const reviewerHistoryStore = createLazyObject(
      () =>
        ({
          add: () => true,
        }) as any,
    );

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: reviewerSessionManager as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: (sessionId, entry) => reviewerHistoryStore.add(sessionId, entry),
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const task = ctx.taskStore.createTask(
      {
        title: "Bootstrap task",
        prompt: "Prepare isolated repo",
        reviewRequired: true,
        modelParams: {
          bootstrap: {
            enabled: true,
            projectRef: "/tmp/example-repo",
          },
        },
      },
      Date.now(),
    );
    const completed = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done", completedAt: Date.now() }, Date.now());
    ctx.taskQueue.emit("task:completed", { task: completed });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const failed = ctx.taskStore.getTask(task.id);
    assert.equal(failed?.reviewConclusion, "review_snapshot_patch_missing");
    assert.equal(ctx.reviewStore.getLatestSnapshot(), null);
    assert.equal(reviewPrompts.length, 0);
    assert.deepEqual(inspectLazyObject(reviewerSessionManager), {
      materialized: false,
      materializeCount: 0,
    });
    assert.deepEqual(inspectLazyObject(reviewerHistoryStore), {
      materialized: false,
      materializeCount: 0,
    });
  });
});

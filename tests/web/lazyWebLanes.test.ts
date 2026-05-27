import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import {
  createWebLaneResources,
  inspectLazyObject,
} from "../../server/web/server/start/webLaneResources.js";

function destroySessionManagerIfMaterialized(sessionManager: { destroy: () => void }): void {
  const state = inspectLazyObject(sessionManager);
  if (state && !state.materialized) {
    return;
  }
  sessionManager.destroy();
}

describe("web lazy planner lane", () => {
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

  it("keeps planner lane cold until first use and then reuses the initialized runtime", async () => {
    const lanes = createWebLaneResources({
      stateDbPath: process.env.ADS_STATE_DB_PATH!,
      sessionTimeoutMs: 0,
      sessionCleanupIntervalMs: 0,
      plannerCodexModel: "test-model",
    });
    try {
      assert.deepEqual(lanes.planner.inspectMaterialization(), {
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
    }
  });
});

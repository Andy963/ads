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

describe("web lazy advisor lane", () => {
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

  it("keeps advisor lane cold until first use and then reuses the initialized runtime", async () => {
    const lanes = createWebLaneResources({
      stateDbPath: process.env.ADS_STATE_DB_PATH!,
      sessionTimeoutMs: 0,
      sessionCleanupIntervalMs: 0,
      advisorCodexModel: "test-model",
    });
    try {
      assert.deepEqual(lanes.advisor.inspectMaterialization(), {
        threadStorage: { materialized: false, materializeCount: 0 },
        historyStore: { materialized: false, materializeCount: 0 },
        sessionManager: { materialized: false, materializeCount: 0 },
        workspaceLockPool: { materialized: false, materializeCount: 0 },
      });
      assert.equal(lanes.advisor.sessionManager.getStats().sandboxMode, "danger-full-access");
      const firstOrchestrator = lanes.advisor.sessionManager.getOrCreate(123, workspaceRoot, false);
      assert.equal(firstOrchestrator.status().streaming, true);
      assert.equal(lanes.advisor.historyStore.add("advisor::session", { role: "user", text: "/pwd", ts: Date.now() }), true);
      const firstLock = lanes.advisor.getWorkspaceLock(workspaceRoot);
      await firstLock.runExclusive(() => "ok");

      assert.deepEqual(lanes.advisor.inspectMaterialization(), {
        threadStorage: { materialized: true, materializeCount: 1 },
        historyStore: { materialized: true, materializeCount: 1 },
        sessionManager: { materialized: true, materializeCount: 1 },
        workspaceLockPool: { materialized: true, materializeCount: 1 },
      });
      const secondOrchestrator = lanes.advisor.sessionManager.getOrCreate(123, workspaceRoot, false);
      assert.equal(secondOrchestrator, firstOrchestrator);
      const secondLock = lanes.advisor.getWorkspaceLock(workspaceRoot);
      assert.equal(secondLock, firstLock);
      assert.deepEqual(lanes.advisor.inspectMaterialization(), {
        threadStorage: { materialized: true, materializeCount: 1 },
        historyStore: { materialized: true, materializeCount: 1 },
        sessionManager: { materialized: true, materializeCount: 1 },
        workspaceLockPool: { materialized: true, materializeCount: 1 },
      });
    } finally {
      lanes.worker.sessionManager.destroy();
      destroySessionManagerIfMaterialized(lanes.advisor.sessionManager);
    }
  });

  it("supports overriding advisor sandbox mode via environment variable and explicit argument", () => {
    try {
      process.env.ADS_ADVISOR_SANDBOX_MODE = "workspace-write";
      const envLanes = createWebLaneResources({
        stateDbPath: process.env.ADS_STATE_DB_PATH!,
        sessionTimeoutMs: 0,
        sessionCleanupIntervalMs: 0,
      });
      try {
        assert.equal(envLanes.advisor.sessionManager.getStats().sandboxMode, "workspace-write");
      } finally {
        envLanes.worker.sessionManager.destroy();
        destroySessionManagerIfMaterialized(envLanes.advisor.sessionManager);
      }

      process.env.ADS_ADVISOR_SANDBOX_MODE = "not-a-sandbox-mode";
      const invalidEnvLanes = createWebLaneResources({
        stateDbPath: process.env.ADS_STATE_DB_PATH!,
        sessionTimeoutMs: 0,
        sessionCleanupIntervalMs: 0,
      });
      try {
        assert.equal(invalidEnvLanes.advisor.sessionManager.getStats().sandboxMode, "workspace-write");
      } finally {
        invalidEnvLanes.worker.sessionManager.destroy();
        destroySessionManagerIfMaterialized(invalidEnvLanes.advisor.sessionManager);
      }

      const argLanes = createWebLaneResources({
        stateDbPath: process.env.ADS_STATE_DB_PATH!,
        sessionTimeoutMs: 0,
        sessionCleanupIntervalMs: 0,
        advisorSandboxMode: "read-only",
      });
      try {
        assert.equal(argLanes.advisor.sessionManager.getStats().sandboxMode, "read-only");
      } finally {
        argLanes.worker.sessionManager.destroy();
        destroySessionManagerIfMaterialized(argLanes.advisor.sessionManager);
      }
    } finally {
      delete process.env.ADS_ADVISOR_SANDBOX_MODE;
    }
  });
});

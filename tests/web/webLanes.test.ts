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
import { WorkspaceLockPool } from "../../server/web/server/workspaceLockPool.js";
import { resolveWsLaneResources } from "../../server/web/server/ws/laneResources.js";

function destroySessionManagerIfMaterialized(sessionManager: { destroy: () => void }): void {
  const state = inspectLazyObject(sessionManager);
  if (state && !state.materialized) {
    return;
  }
  sessionManager.destroy();
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("web/ws/laneResources", () => {
  it("selects worker resources for the main chat lane", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      advisorSessionManager: { id: "advisor-session" },
      getWorkspaceLock: () => "worker-lock",
      getAdvisorWorkspaceLock: () => "advisor-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      advisorHistoryStore: { id: "advisor-history" },
    };

    const resolved = resolveWsLaneResources({
      chatSessionId: "main",
      sessions: sessions as any,
      history: history as any,
    });

    assert.equal(resolved.isAdvisorChat, false);
    assert.equal((resolved.sessionManager as any).id, "worker-session");
    assert.equal((resolved.historyStore as any).id, "worker-history");
    assert.equal(resolved.getWorkspaceLock("/tmp"), "worker-lock");
  });

  it("selects advisor resources for advisor and worker resources for other lanes", () => {
    const sessions = {
      workerSessionManager: { id: "worker-session" },
      advisorSessionManager: { id: "advisor-session" },
      getWorkspaceLock: () => "worker-lock",
      getAdvisorWorkspaceLock: () => "advisor-lock",
    };
    const history = {
      workerHistoryStore: { id: "worker-history" },
      advisorHistoryStore: { id: "advisor-history" },
    };

    const advisor = resolveWsLaneResources({
      chatSessionId: "advisor",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(advisor.isAdvisorChat, true);
    assert.equal((advisor.sessionManager as any).id, "advisor-session");
    assert.equal((advisor.historyStore as any).id, "advisor-history");
    assert.equal(advisor.getWorkspaceLock("/tmp"), "advisor-lock");

    const other = resolveWsLaneResources({
      chatSessionId: "custom-worker",
      sessions: sessions as any,
      history: history as any,
    });
    assert.equal(other.isAdvisorChat, false);
    assert.equal((other.sessionManager as any).id, "worker-session");
    assert.equal((other.historyStore as any).id, "worker-history");
    assert.equal(other.getWorkspaceLock("/tmp"), "worker-lock");
  });
});

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

describe("web/workspaceLockPool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-lock-pool-"));
    fs.mkdirSync(path.join(tmpDir, "a"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "b"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "c"), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("evicts the oldest idle lock when maxEntries is exceeded", () => {
    const pool = new WorkspaceLockPool({ maxEntries: 2 });
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");
    const dirC = path.join(tmpDir, "c");

    const lockA = pool.get(dirA);
    const lockB = pool.get(dirB);
    pool.get(dirC);

    assert.equal(pool.get(dirB), lockB);
    assert.notEqual(pool.get(dirA), lockA);
  });

  it("refreshes LRU order on get() hit", () => {
    const pool = new WorkspaceLockPool({ maxEntries: 2 });
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");
    const dirC = path.join(tmpDir, "c");

    const lockA = pool.get(dirA);
    const lockB = pool.get(dirB);
    assert.equal(pool.get(dirA), lockA);
    pool.get(dirC);

    assert.equal(pool.get(dirA), lockA);
    assert.notEqual(pool.get(dirB), lockB);
  });

  it("does not evict busy locks", async () => {
    const pool = new WorkspaceLockPool({ maxEntries: 1 });
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");

    const lockA = pool.get(dirA);
    const gate = createDeferred<void>();
    const running = lockA.runExclusive(async () => {
      await gate.promise;
    });

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(lockA.isBusy(), true);

    pool.get(dirB);
    assert.equal(pool.get(dirA), lockA);

    gate.resolve();
    await running;
    assert.equal(lockA.isBusy(), false);
  });
});

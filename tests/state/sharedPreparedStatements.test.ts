import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/telegram/utils/threadStorage.js";
import { HistoryStore } from "../../server/utils/historyStore.js";

describe("shared prepared statements on state.db", () => {
  let tmpDir: string;
  let stateDbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-shared-state-statements-"));
    stateDbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = stateDbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("does not prepare a fresh thread/history statement set for each additional lane", () => {
    const db = getStateDatabase(stateDbPath);
    const originalPrepare = db.prepare.bind(db);
    let prepareCount = 0;

    (db as { prepare: typeof db.prepare }).prepare = ((...args: Parameters<typeof db.prepare>) => {
      prepareCount += 1;
      return originalPrepare(...args);
    }) as typeof db.prepare;

    try {
      const workerThreads = new ThreadStorage({ namespace: "web-worker", stateDbPath });
      const workerHistory = new HistoryStore({ namespace: "web-worker", storagePath: stateDbPath });
      const afterWorkerLane = prepareCount;

      assert.ok(afterWorkerLane > 0);

      const plannerThreads = new ThreadStorage({ namespace: "web-planner", stateDbPath });
      const plannerHistory = new HistoryStore({ namespace: "web-planner", storagePath: stateDbPath });
      const reviewerThreads = new ThreadStorage({ namespace: "web-reviewer", stateDbPath });
      const reviewerHistory = new HistoryStore({ namespace: "web-reviewer", storagePath: stateDbPath });

      assert.equal(prepareCount, afterWorkerLane);

      workerThreads.setRecord(1, { threadId: "worker-thread", cwd: "/tmp/worker", agentThreads: { codex: "worker-thread" } });
      plannerThreads.setRecord(1, { threadId: "planner-thread", cwd: "/tmp/planner", agentThreads: { codex: "planner-thread" } });
      reviewerThreads.setRecord(1, { threadId: "reviewer-thread", cwd: "/tmp/reviewer", agentThreads: { codex: "reviewer-thread" } });

      workerHistory.add("session-1", { role: "user", text: "worker-entry", ts: 1 });
      plannerHistory.add("session-1", { role: "user", text: "planner-entry", ts: 2 });
      reviewerHistory.add("session-1", { role: "user", text: "reviewer-entry", ts: 3 });

      assert.equal(workerThreads.getRecord(1)?.threadId, "worker-thread");
      assert.equal(plannerThreads.getRecord(1)?.threadId, "planner-thread");
      assert.equal(reviewerThreads.getRecord(1)?.threadId, "reviewer-thread");

      assert.deepEqual(workerHistory.get("session-1").map((entry) => entry.text), ["worker-entry"]);
      assert.deepEqual(plannerHistory.get("session-1").map((entry) => entry.text), ["planner-entry"]);
      assert.deepEqual(reviewerHistory.get("session-1").map((entry) => entry.text), ["reviewer-entry"]);
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = originalPrepare as typeof db.prepare;
    }
  });
});

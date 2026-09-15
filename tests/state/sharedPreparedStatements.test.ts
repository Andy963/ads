import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";
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

      const advisorThreads = new ThreadStorage({ namespace: "web-advisor", stateDbPath });
      const advisorHistory = new HistoryStore({ namespace: "web-advisor", storagePath: stateDbPath });
      const customThreads = new ThreadStorage({ namespace: "web-custom", stateDbPath });
      const customHistory = new HistoryStore({ namespace: "web-custom", storagePath: stateDbPath });

      assert.equal(prepareCount, afterWorkerLane);

      workerThreads.setRecord(1, { threadId: "worker-thread", cwd: "/tmp/worker", agentThreads: { codex: "worker-thread" } });
      advisorThreads.setRecord(1, { threadId: "advisor-thread", cwd: "/tmp/advisor", agentThreads: { codex: "advisor-thread" } });
      customThreads.setRecord(1, { threadId: "custom-thread", cwd: "/tmp/custom", agentThreads: { codex: "custom-thread" } });

      workerHistory.add("session-1", { role: "user", text: "worker-entry", ts: 1 });
      advisorHistory.add("session-1", { role: "user", text: "advisor-entry", ts: 2 });
      customHistory.add("session-1", { role: "user", text: "custom-entry", ts: 3 });

      assert.equal(workerThreads.getRecord(1)?.threadId, "worker-thread");
      assert.equal(advisorThreads.getRecord(1)?.threadId, "advisor-thread");
      assert.equal(customThreads.getRecord(1)?.threadId, "custom-thread");

      assert.deepEqual(workerHistory.get("session-1").map((entry) => entry.text), ["worker-entry"]);
      assert.deepEqual(advisorHistory.get("session-1").map((entry) => entry.text), ["advisor-entry"]);
      assert.deepEqual(customHistory.get("session-1").map((entry) => entry.text), ["custom-entry"]);
    } finally {
      (db as { prepare: typeof db.prepare }).prepare = originalPrepare as typeof db.prepare;
    }
  });
});

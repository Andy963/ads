import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/telegram/utils/threadStorage.js";

describe("ThreadStorage", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    resetStateDatabaseForTests();
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      tmpDir = null;
    }
  });

  it("clones records while preserving updatedAt semantics", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
    const stateDbPath = path.join(tmpDir, "state.db");
    const storagePath = path.join(tmpDir, "legacy-threads.json");
    const saltPath = path.join(tmpDir, "salt");

    const storage = new ThreadStorage({ namespace: "test", stateDbPath, storagePath, saltPath });

    storage.setRecord(1, { threadId: "thread-1", cwd: "/tmp/a", agentThreads: { codex: "thread-1" } });
    const from = storage.getRecord(1);
    assert.ok(from?.threadId);
    assert.ok(from?.updatedAt);

    const cloned = storage.cloneRecord(1, 2);
    assert.equal(cloned, true);

    const to = storage.getRecord(2);
    assert.equal(to?.threadId, from?.threadId);
    assert.equal(to?.cwd, from?.cwd);
    assert.equal(to?.updatedAt, from?.updatedAt);

    const secondClone = storage.cloneRecord(1, 2);
    assert.equal(secondClone, false);
  });

  it("round-trips metadata-only state and preserves it across thread updates", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
    const stateDbPath = path.join(tmpDir, "state.db");
    const storagePath = path.join(tmpDir, "legacy-threads.json");
    const saltPath = path.join(tmpDir, "salt");

    const storage = new ThreadStorage({ namespace: "test", stateDbPath, storagePath, saltPath });

    storage.setRecord(3, {
      cwd: "/tmp/project",
      model: "gpt-4o",
      modelReasoningEffort: "xhigh",
      activeAgentId: "codex",
      agentThreads: {},
    });

    let record = storage.getRecord(3);
    assert.equal(record?.model, "gpt-4o");
    assert.equal(record?.modelReasoningEffort, "xhigh");
    assert.equal(record?.activeAgentId, "codex");
    assert.equal(record?.threadId, undefined);
    assert.deepEqual(record?.agentThreads, {});

    storage.setThreadId(3, "thread-3", "codex");
    record = storage.getRecord(3);
    assert.equal(record?.threadId, "thread-3");
    assert.equal(record?.model, "gpt-4o");
    assert.equal(record?.modelReasoningEffort, "xhigh");
    assert.equal(record?.activeAgentId, "codex");
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";

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

  it("clears one agent's session id without touching the others", () => {
    // The old stale-thread branch wrote `agentThreads: { resume: <id> }`, which
    // replaced the whole map and silently discarded every other agent's id.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "legacy-threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });

    storage.setRecord(1, {
      threadId: "codex-thread",
      cwd: "/tmp/a",
      agentThreads: { codex: "codex-thread", claude: "claude-session", gemini: "gemini-session" },
      activeAgentId: "codex",
    });

    storage.clearThreadId(1, "claude");

    const record = storage.getRecord(1);
    assert.equal(record?.agentThreads?.claude, undefined);
    assert.equal(record?.agentThreads?.codex, "codex-thread");
    assert.equal(record?.agentThreads?.gemini, "gemini-session");
    assert.equal(record?.cwd, "/tmp/a");
    assert.equal(record?.activeAgentId, "codex");
  });

  it("clears the legacy top-level threadId when codex is the cleared agent", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "legacy-threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });

    storage.setRecord(1, {
      threadId: "codex-thread",
      cwd: "/tmp/a",
      agentThreads: { codex: "codex-thread", claude: "claude-session" },
    });

    storage.clearThreadId(1, "codex");

    // `getThreadId("codex")` falls back to the top-level column, so leaving it
    // set would hand back the dead id the caller just asked to forget.
    assert.equal(storage.getThreadId(1, "codex"), undefined);
    assert.equal(storage.getThreadId(1, "claude"), "claude-session");
  });

  it("is a no-op for an unknown user or agent", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-thread-storage-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "legacy-threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });

    storage.clearThreadId(99, "codex");
    assert.equal(storage.getRecord(99), undefined);

    storage.setRecord(1, { threadId: "codex-thread", cwd: "/tmp/a", agentThreads: { codex: "codex-thread" } });
    const before = storage.getRecord(1)?.updatedAt;
    storage.clearThreadId(1, "gemini");
    assert.equal(storage.getThreadId(1, "codex"), "codex-thread");
    assert.equal(storage.getRecord(1)?.updatedAt, before);
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

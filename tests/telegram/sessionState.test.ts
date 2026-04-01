import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/telegram/utils/threadStorage.js";
import {
  buildPreservedResetState,
  buildSyncedSessionState,
  clearSavedResumeThreadId,
  getSavedResumeThreadId,
} from "../../server/telegram/utils/sessionState.js";

describe("telegram/sessionState helpers", () => {
  let tmpDir: string;
  let storage: ThreadStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-state-"));
    storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads and clears saved resume thread ids", () => {
    storage.setRecord(1, {
      threadId: undefined,
      cwd: "/tmp/project",
      agentThreads: { resume: "resume-thread", codex: "current-thread" },
      model: "gpt-4.1",
      activeAgentId: "codex",
    });

    assert.equal(getSavedResumeThreadId(storage, 1), "resume-thread");

    clearSavedResumeThreadId(storage, 1);
    assert.equal(getSavedResumeThreadId(storage, 1), undefined);
    assert.deepEqual(storage.getRecord(1)?.agentThreads, { codex: "current-thread" });
  });

  it("removes metadata-less records when clearing the last saved resume thread", () => {
    storage.setRecord(2, {
      threadId: undefined,
      cwd: "/tmp/project",
      agentThreads: { resume: "resume-thread" },
    });

    clearSavedResumeThreadId(storage, 2);
    assert.equal(storage.getRecord(2), undefined);
  });

  it("builds synced state while preserving metadata and optionally clearing threads", () => {
    const synced = buildSyncedSessionState({
      storedState: {
        threadId: "thread-1",
        cwd: "/tmp/project",
        agentThreads: { codex: "thread-1" },
        model: "gpt-4.1",
        modelReasoningEffort: "medium",
        activeAgentId: "codex",
      },
      sessionState: {
        cwd: "/tmp/project-next",
        model: "gpt-4o",
        activeAgentId: "claude",
      },
      userModelReasoningEffort: "high",
      clearThreads: true,
    });

    assert.deepEqual(synced, {
      threadId: undefined,
      cwd: "/tmp/project-next",
      agentThreads: {},
      model: "gpt-4o",
      modelReasoningEffort: "high",
      activeAgentId: "claude",
    });
  });

  it("builds preserved reset state for resume fallback", () => {
    const nextState = buildPreservedResetState({
      currentThreadId: "thread-live",
      savedState: {
        cwd: "/tmp/project",
        model: "gpt-4.1",
        activeAgentId: "codex",
      },
    });

    assert.deepEqual(nextState, {
      cwd: "/tmp/project",
      model: "gpt-4.1",
      activeAgentId: "codex",
      threadId: undefined,
      agentThreads: { resume: "thread-live" },
    });
  });
});

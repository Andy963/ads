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
  resolveResumeState,
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
      reviewerSnapshotId: "snapshot-1",
    });

    assert.equal(getSavedResumeThreadId(storage, 1), "resume-thread");

    clearSavedResumeThreadId(storage, 1);
    assert.equal(getSavedResumeThreadId(storage, 1), undefined);
    assert.deepEqual(storage.getRecord(1)?.agentThreads, { codex: "current-thread" });
    assert.equal(storage.getRecord(1)?.reviewerSnapshotId, "snapshot-1");
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
        reviewerSnapshotId: "snapshot-1",
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
      reviewerSnapshotId: "snapshot-1",
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

  it("classifies restore mode as fresh when resume was requested without a saved thread", () => {
    const resume = resolveResumeState({
      userId: 10,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      resumeTtlMs: 60_000,
    });

    assert.equal(resume.restoreMode, "fresh");
    assert.equal(resume.resumeThreadId, undefined);
    assert.equal(resume.shouldInjectHistory, false);
  });

  it("classifies restore mode as thread_resumed when a saved thread is still fresh", () => {
    storage.setRecord(11, {
      threadId: "thread-11",
      cwd: "/tmp/project",
      agentThreads: { codex: "thread-11" },
      activeAgentId: "codex",
    });

    const resume = resolveResumeState({
      userId: 11,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      resumeTtlMs: 60_000,
    });

    assert.equal(resume.restoreMode, "thread_resumed");
    assert.equal(resume.resumeThreadId, "thread-11");
    assert.equal(resume.shouldInjectHistory, false);
  });

  it("skips auto-resume when the current cwd no longer matches the saved cwd", () => {
    storage.setRecord(12, {
      threadId: "thread-12",
      cwd: "/tmp/project-a",
      agentThreads: { codex: "thread-12", claude: "claude-thread-12" },
      activeAgentId: "codex",
    });

    const resume = resolveResumeState({
      userId: 12,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      resumeTtlMs: 60_000,
      currentCwd: "/tmp/project-b",
    });

    assert.equal(resume.restoreMode, "fresh");
    assert.equal(resume.resumeThreadId, undefined);
    assert.equal(resume.resumeThreadIds, undefined);
    assert.equal(resume.shouldInjectHistory, false);
  });
});

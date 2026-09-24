import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";
import { RUNTIME_CAPABILITY_MATRIX } from "../../server/runtime/config.js";
import {
  buildPreservedResetState,
  buildSyncedSessionState,
  clearSavedResumeThreadId,
  getSavedResumeThreadId,
  resolveResumeState,
  RuntimeBackendMismatchError,
} from "../../server/sessions/sessionState.js";

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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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
      activeAgentId: "codex",
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

  it("injects history when saved model state remains after provider threads were cleared", () => {
    storage.setRecord(14, {
      cwd: "/tmp/project",
      agentThreads: {},
      model: "gpt-4o",
      activeAgentId: "codex",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
    });

    const resume = resolveResumeState({
      userId: 14,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      resumeTtlMs: 60_000,
      currentCwd: "/tmp/project",
    });

    assert.equal(resume.restoreMode, "history_injection");
    assert.equal(resume.resumeThreadId, undefined);
    assert.equal(resume.shouldInjectHistory, true);
  });

  it("resumes the canonical Codex thread from a legacy active-agent marker", () => {
    storage.setRecord(15, {
      cwd: "/tmp/project",
      agentThreads: { codex: "codex-thread" },
      activeAgentId: "claude",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
    });

    const resume = resolveResumeState({
      userId: 15,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      resumeTtlMs: 60_000,
      currentCwd: "/tmp/project",
    });

    assert.equal(resume.activeAgentId, undefined);
    assert.equal(resume.resumeThreadId, "codex-thread");
    assert.equal(resume.restoreMode, "thread_resumed");
    assert.equal(resume.shouldInjectHistory, false);
  });

  it("does not pass a legacy Claude-only session id to Codex", () => {
    storage.setRecord(16, {
      cwd: "/tmp/project",
      agentThreads: { claude: "claude-thread" },
      activeAgentId: "claude",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
    });

    const resume = resolveResumeState({
      userId: 16,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      currentCwd: "/tmp/project",
    });

    assert.equal(resume.activeAgentId, undefined);
    assert.equal(resume.resumeThreadId, undefined);
    assert.equal(resume.restoreMode, "history_injection");
    assert.equal(resume.shouldInjectHistory, true);
  });

  it("resumes a fresh saved thread natively without history injection", () => {
    storage.setRecord(11, {
      threadId: "thread-11",
      cwd: "/tmp/project",
      agentThreads: { codex: "thread-11" },
      activeAgentId: "codex",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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

  it("uses history injection instead of resuming a native runtime thread", () => {
    storage.setRecord(17, {
      threadId: "native-turn-17",
      cwd: "/tmp/project",
      agentThreads: { codex: "native-turn-17" },
      activeAgentId: "codex",
      runtimeBackend: "native",
      lifecycle: "durable",
    });

    const resume = resolveResumeState({
      userId: 17,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      currentCwd: "/tmp/project",
      runtimeBackend: "native",
    });

    assert.equal(resume.restoreMode, "history_injection");
    assert.equal(resume.resumeThreadId, undefined);
    assert.equal(resume.shouldInjectHistory, true);
  });

  it("keeps auto-resume when reconnect normalizes to a compatible project cwd", () => {
    storage.setRecord(13, {
      threadId: "thread-13",
      cwd: "/tmp/project/src",
      agentThreads: { codex: "thread-13" },
      activeAgentId: "codex",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
    });

    const resume = resolveResumeState({
      userId: 13,
      resumeThread: true,
      storage,
      logger: { info: () => {} },
      resumeTtlMs: 60_000,
      currentCwd: "/tmp/project",
    });

    assert.equal(resume.restoreMode, "thread_resumed");
    assert.equal(resume.resumeThreadId, "thread-13");
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
    assert.equal(resume.shouldInjectHistory, false);
  });

  it("rejects a persisted backend mismatch explicitly", () => {
    storage.setRecord(18, {
      threadId: "native-execution",
      cwd: "/tmp/project",
      agentThreads: { codex: "native-execution" },
      activeAgentId: "codex",
      runtimeBackend: "native",
      lifecycle: "durable",
    });

    assert.throws(
      () => resolveResumeState({
        userId: 18,
        resumeThread: true,
        storage,
        logger: { info: () => {} },
        currentCwd: "/tmp/project",
        runtimeBackend: "codex-app-server",
      }),
      (error: unknown) => {
        assert(error instanceof RuntimeBackendMismatchError);
        assert.match(error.message, /Cross-runtime resume is not supported/);
        return true;
      },
    );
  });

  it("defines backend capabilities without cross-runtime resume", () => {
    assert.equal(RUNTIME_CAPABILITY_MATRIX["codex-app-server"]["provider-thread-resume"], "supported");
    assert.equal(RUNTIME_CAPABILITY_MATRIX.native["provider-thread-resume"], "intentionally-different");
    assert.equal(RUNTIME_CAPABILITY_MATRIX.native["cross-runtime-resume"], "unsupported");
  });
});

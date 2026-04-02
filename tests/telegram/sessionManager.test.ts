import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { getStateDatabase } from "../../server/state/database.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/telegram/utils/threadStorage.js";

type FakeSession = {
  readonly id: number;
  resetCalls: number;
  workingDirectory?: string;
  threadId: string | null;
  model?: string;
  modelReasoningEffort?: string;
  activeAgentId: string;
  send: () => Promise<{ response: string }>;
  onEvent: () => () => void;
  getThreadId: () => string | null;
  getModel: () => string | undefined;
  getModelReasoningEffort: () => string | undefined;
  reset: () => void;
  setModel: (model?: string) => void;
  setModelReasoningEffort: (effort?: string) => void;
  setWorkingDirectory: (workingDirectory?: string) => void;
  status: () => { ready: boolean; streaming: boolean };
  getActiveAgentId: () => string;
  listAgents: () => Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }>;
  switchAgent: (agentId: string) => void;
};

function createFakeSessionFactory() {
  let nextId = 1;
  const created: FakeSession[] = [];

  return {
    created,
    factory: ({
      cwd,
      resumeThreadId,
      resumeThreadIds,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
    }: {
      cwd: string;
      resumeThreadId?: string;
      resumeThreadIds?: Record<string, string>;
      userModel?: string;
      userModelReasoningEffort?: string;
      activeAgentId?: string;
    }) => {
      const initialAgentId = activeAgentId ?? "codex";
      const session: FakeSession = {
        id: nextId++,
        resetCalls: 0,
        workingDirectory: cwd,
        threadId: resumeThreadIds?.[initialAgentId] ?? resumeThreadId ?? null,
        model: userModel,
        modelReasoningEffort: userModelReasoningEffort,
        activeAgentId: initialAgentId,
        send: async () => ({ response: "ok" }),
        onEvent: () => () => {},
        getThreadId: () => session.threadId,
        getModel: () => session.model,
        getModelReasoningEffort: () => session.modelReasoningEffort,
        reset: () => {
          session.resetCalls += 1;
          session.threadId = null;
        },
        setModel: (model) => {
          session.model = model;
          session.threadId = null;
        },
        setModelReasoningEffort: (effort) => {
          session.modelReasoningEffort = effort;
        },
        setWorkingDirectory: (workingDirectory) => {
          session.workingDirectory = workingDirectory;
          session.threadId = null;
        },
        status: () => ({ ready: true, streaming: true }),
        getActiveAgentId: () => session.activeAgentId,
        listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        switchAgent: (agentId) => {
          session.activeAgentId = agentId;
          session.threadId = resumeThreadIds?.[agentId] ?? null;
        },
      };
      created.push(session);
      return session as unknown as ReturnType<SessionManager["getOrCreate"]>;
    },
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("SessionManager", () => {
  let manager: SessionManager;
  let tmpDir: string | null = null;

  afterEach(() => {
    manager?.destroy();
    resetStateDatabaseForTests();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  beforeEach(() => {
    const sessions = createFakeSessionFactory();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      createSession: sessions.factory as never,
    });
  });

  it("creates and reuses the active session for a user", () => {
    const session1 = manager.getOrCreate(123456, "/tmp/a");
    const session2 = manager.getOrCreate(123456, "/tmp/a");

    assert.equal(session1, session2);
    assert.equal(manager.getUserCwd(123456), "/tmp/a");
    assert.equal(manager.getContextRestoreMode(123456), "fresh");
  });

  it("evicts idle sessions, resets heavy state, and recreates them on demand", async () => {
    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(20, 10, "workspace-write", undefined, undefined, undefined, {
      createSession: sessions.factory as never,
    });

    const first = manager.getOrCreate(123456, "/tmp/a");
    assert.equal(manager.hasSession(123456), true);

    await waitForCondition(() => !manager.hasSession(123456));

    assert.equal(manager.getStats().total, 0);
    assert.equal(sessions.created[0]?.resetCalls, 1);

    const recreated = manager.getOrCreate(123456, "/tmp/a");
    assert.notEqual(recreated, first);
    assert.equal(manager.hasSession(123456), true);
  });

  it("drops sessions through the shared disposal path", () => {
    const sessions = createFakeSessionFactory();
    const disposals: Array<{ userId: number; reason: string }> = [];
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      createSession: sessions.factory as never,
      onDispose: ({ userId, reason }) => {
        disposals.push({ userId, reason });
      },
    });

    manager.getOrCreate(123456, "/tmp/a");
    manager.dropSession(123456);

    assert.equal(manager.hasSession(123456), false);
    assert.equal(sessions.created[0]?.resetCalls, 1);
    assert.deepEqual(disposals, [{ userId: 123456, reason: "drop" }]);
  });

  it("tracks session statistics", () => {
    manager.getOrCreate(123456);
    manager.getOrCreate(789012);

    const stats = manager.getStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.active, 2);
  });

  it("tracks user model", () => {
    manager.setUserModel(123456, "model-override");
    assert.equal(manager.getUserModel(123456), "model-override");
  });

  it("tracks user cwd", () => {
    manager.getOrCreate(123456, "/home/test");
    assert.equal(manager.getUserCwd(123456), "/home/test");

    manager.setUserCwd(123456, "/home/other");
    assert.equal(manager.getUserCwd(123456), "/home/other");
  });

  it("restores saved model, reasoning effort, active agent, and agent thread", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(42, {
      threadId: "codex-thread",
      cwd: "/tmp/project",
      agentThreads: { codex: "codex-thread", claude: "claude-thread" },
      model: "claude-sonnet",
      modelReasoningEffort: "xhigh",
      activeAgentId: "claude",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(42, "/tmp/project", true) as unknown as FakeSession;
    assert.equal(session.getModel(), "claude-sonnet");
    assert.equal(session.getModelReasoningEffort(), "xhigh");
    assert.equal(session.getActiveAgentId(), "claude");
    assert.equal(session.getThreadId(), "claude-thread");
    assert.equal(manager.getContextRestoreMode(42), "thread_resumed");
  });

  it("keeps fresh restore mode when no saved thread exists even if resume was requested", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(77, "/tmp/project", true) as unknown as FakeSession;
    assert.equal(session.getThreadId(), null);
    assert.equal(manager.getContextRestoreMode(77), "fresh");
  });

  it("skips automatic resume when the requested cwd diverges from the saved cwd", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(78, {
      threadId: "thread-78",
      cwd: "/tmp/project-a",
      agentThreads: { codex: "thread-78" },
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(78, "/tmp/project-b", true) as unknown as FakeSession;
    assert.equal(session.getThreadId(), null);
    assert.equal(session.workingDirectory, "/tmp/project-b");
    assert.equal(manager.getContextRestoreMode(78), "fresh");
  });

  it("falls back to history injection when a saved thread is stale", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const stateDbPath = path.join(tmpDir, "state.db");
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath,
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(42, {
      threadId: "codex-thread",
      cwd: "/tmp/project",
      agentThreads: { codex: "codex-thread" },
      activeAgentId: "codex",
    });
    getStateDatabase(stateDbPath)
      .prepare("UPDATE thread_state SET updated_at = ? WHERE namespace = ?")
      .run(Date.now() - 10_000, "test");

    const previousTtl = process.env.ADS_THREAD_RESUME_TTL_MS;
    process.env.ADS_THREAD_RESUME_TTL_MS = "1";

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    try {
      const session = manager.getOrCreate(42, "/tmp/project", true) as unknown as FakeSession;
      assert.equal(session.getThreadId(), null);
      assert.equal(manager.needsHistoryInjection(42), true);
      assert.equal(manager.getContextRestoreMode(42), "history_injection");
      assert.equal(storage.getRecord(42)?.agentThreads?.resume, "codex-thread");
    } finally {
      if (previousTtl === undefined) {
        delete process.env.ADS_THREAD_RESUME_TTL_MS;
      } else {
        process.env.ADS_THREAD_RESUME_TTL_MS = previousTtl;
      }
    }
  });

  it("clears saved thread bindings but preserves authoritative model metadata on model switch", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(7, {
      threadId: "thread-1",
      cwd: "/tmp/project",
      agentThreads: { codex: "thread-1" },
      model: "gpt-4.1",
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    manager.getOrCreate(7, "/tmp/project", true);
    manager.setUserModel(7, "gpt-4o");

    const record = storage.getRecord(7);
    assert.equal(record?.model, "gpt-4o");
    assert.equal(record?.threadId, undefined);
    assert.deepEqual(record?.agentThreads, {});
    assert.equal(record?.activeAgentId, "codex");
  });

  it("preserves explicit resume after rebinding the saved thread to the current cwd", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(79, {
      threadId: "stale-thread",
      cwd: "/tmp/project-a",
      agentThreads: { codex: "stale-thread" },
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    manager.getOrCreate(79, "/tmp/project-b", false);
    manager.saveThreadId(79, "manual-thread", "codex");
    manager.dropSession(79);

    const resumed = manager.getOrCreate(79, "/tmp/project-b", true) as unknown as FakeSession;
    assert.equal(storage.getRecord(79)?.cwd, "/tmp/project-b");
    assert.equal(resumed.getThreadId(), "manual-thread");
    assert.equal(manager.getContextRestoreMode(79), "thread_resumed");
  });
});

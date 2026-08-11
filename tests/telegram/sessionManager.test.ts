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
  setWorkingDirectory: (workingDirectory?: string, options?: { preserveSession?: boolean }) => void;
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
        setWorkingDirectory: (workingDirectory, options) => {
          session.workingDirectory = workingDirectory;
          if (!options?.preserveSession) {
            session.threadId = null;
          }
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
  let workspaceDir: string | null = null;

  afterEach(() => {
    manager?.destroy();
    resetStateDatabaseForTests();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
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

  it("marks history injection when a model change clears provider threads", () => {
    const session = manager.getOrCreate(123456, "/tmp/a") as unknown as FakeSession;
    session.threadId = "thread-before-model-change";

    manager.setUserModel(123456, "model-override");

    assert.equal(session.threadId, null);
    assert.equal(manager.needsHistoryInjection(123456), true);
    assert.equal(manager.getContextRestoreMode(123456), "history_injection");
  });

  it("injects history when switching to an agent with no session of its own", () => {
    const session = manager.getOrCreate(123456, "/tmp/a") as unknown as FakeSession;
    session.threadId = "codex-thread";
    session.switchAgent = (agentId) => {
      session.activeAgentId = agentId;
      session.threadId = "claude-thread";
    };

    const result = manager.switchAgent(123456, "claude");

    assert.equal(result.success, true);
    assert.equal(session.threadId, "claude-thread");
    // No storage is attached here, so the target has nothing to reattach to and
    // the ADS history is the only way to carry context across the switch.
    assert.equal(manager.needsHistoryInjection(123456), true);
    assert.equal(manager.getContextRestoreMode(123456), "history_injection");
  });

  it("does not inject history when the target agent has its own saved session", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(321, {
      threadId: "codex-thread",
      cwd: "/tmp/a",
      agentThreads: { codex: "codex-thread", claude: "claude-session" },
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(321, "/tmp/a", true) as unknown as FakeSession;
    session.switchAgent = (agentId) => {
      session.activeAgentId = agentId;
      session.threadId = "claude-session";
    };

    const result = manager.switchAgent(321, "claude");

    assert.equal(result.success, true);
    // Claude resumes its own transcript, so injecting ADS history on top would
    // make the model read the same turns twice.
    assert.equal(manager.needsHistoryInjection(321), false);
  });

  it("tracks user cwd", () => {
    manager.getOrCreate(123456, "/home/test");
    assert.equal(manager.getUserCwd(123456), "/home/test");

    manager.setUserCwd(123456, "/home/other");
    assert.equal(manager.getUserCwd(123456), "/home/other");
  });

  it("preserves saved threads across compatible cwd rebinding and reconnect resume", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-workspace-"));
    const workspaceRoot = workspaceDir;
    const nestedWorkspace = path.join(workspaceRoot, "nested");
    fs.mkdirSync(nestedWorkspace, { recursive: true });
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(80, {
      threadId: "thread-80",
      cwd: workspaceRoot,
      agentThreads: { codex: "thread-80" },
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const initial = manager.getOrCreate(80, workspaceRoot, true) as unknown as FakeSession;
    assert.equal(initial.getThreadId(), "thread-80");

    manager.setUserCwd(80, nestedWorkspace);
    assert.equal(initial.getThreadId(), "thread-80");
    assert.equal(storage.getRecord(80)?.cwd, nestedWorkspace);
    assert.equal(storage.getRecord(80)?.threadId, "thread-80");
    assert.deepEqual(storage.getRecord(80)?.agentThreads, { codex: "thread-80" });

    manager.dropSession(80);

    const resumed = manager.getOrCreate(80, nestedWorkspace, true) as unknown as FakeSession;
    assert.equal(resumed.getThreadId(), "thread-80");
    // The provider reloads this thread natively, so ADS must not replay its own history on top.
    assert.equal(manager.getContextRestoreMode(80), "thread_resumed");
    assert.equal(manager.needsHistoryInjection(80), false);
  });

  it("clears saved threads when cwd rebinding crosses to an incompatible workspace", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath: path.join(tmpDir, "state.db"),
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(81, {
      threadId: "thread-81",
      cwd: "/tmp/project-a",
      agentThreads: { codex: "thread-81" },
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    manager.getOrCreate(81, "/tmp/project-a", true);
    manager.setUserCwd(81, "/tmp/project-b");

    const record = storage.getRecord(81);
    const active = manager.getOrCreate(81, "/tmp/project-b") as unknown as FakeSession;
    assert.equal(active.getThreadId(), null);
    assert.equal(record?.cwd, "/tmp/project-b");
    assert.equal(record?.threadId, undefined);
    assert.deepEqual(record?.agentThreads, {});
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
    assert.equal(manager.needsHistoryInjection(42), false);
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

  it("resumes a long-idle saved thread instead of dropping it", () => {
    // A rollout on disk does not expire, so idle time is not evidence that
    // resuming would fail. Dropping the thread on a timer used to guarantee the
    // very context loss it was meant to avoid.
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
      agentThreads: { codex: "codex-thread", claude: "claude-session" },
      activeAgentId: "codex",
    });
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    getStateDatabase(stateDbPath)
      .prepare("UPDATE thread_state SET updated_at = ? WHERE namespace = ?")
      .run(thirtyDaysAgo, "test");

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(42, "/tmp/project", true) as unknown as FakeSession;
    assert.equal(session.getThreadId(), "codex-thread");
    assert.equal(manager.needsHistoryInjection(42), false);
    assert.equal(manager.getContextRestoreMode(42), "thread_resumed");
    // The other agent's id must survive: the old stale branch replaced the whole
    // map with `{ resume: <id> }`, silently discarding every other agent.
    assert.equal(storage.getRecord(42)?.agentThreads?.claude, "claude-session");
  });

  it("resumes rather than creating a fresh session when the caller omits the flag", () => {
    // Read-only callers (agent snapshots, model overrides) reach getOrCreate
    // without an opinion. Defaulting to fresh stranded the saved thread id for
    // the rest of the process, because the next connect saw a live session and
    // skipped resuming too.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-session-manager-"));
    const stateDbPath = path.join(tmpDir, "state.db");
    const storage = new ThreadStorage({
      namespace: "test",
      stateDbPath,
      storagePath: path.join(tmpDir, "threads.json"),
      saltPath: path.join(tmpDir, "salt"),
    });
    storage.setRecord(7, {
      threadId: "codex-thread",
      cwd: "/tmp/project",
      agentThreads: { codex: "codex-thread" },
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(7, "/tmp/project") as unknown as FakeSession;
    assert.equal(session.getThreadId(), "codex-thread");
    assert.equal(manager.getContextRestoreMode(7), "thread_resumed");
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
    assert.equal(manager.needsHistoryInjection(79), false);
  });
});

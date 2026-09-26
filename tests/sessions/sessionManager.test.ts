import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../../server/sessions/sessionManager.js";
import { getStateDatabase } from "../../server/state/database.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { ThreadStorage } from "../../server/sessions/threadStorage.js";

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
  getAdapter: (agentId: string) => { preservesThreadOnModelChange: boolean } | null;
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
      userModel,
      userModelReasoningEffort,
      activeAgentId,
    }: {
      cwd: string;
      resumeThreadId?: string;
      userModel?: string;
      userModelReasoningEffort?: string;
      activeAgentId?: string;
    }) => {
      const initialAgentId = activeAgentId ?? "codex";
      const session: FakeSession = {
        id: nextId++,
        resetCalls: 0,
        workingDirectory: cwd,
        threadId: resumeThreadId ?? null,
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
        getAdapter: (agentId) => agentId === session.activeAgentId
          ? { preservesThreadOnModelChange: true }
          : null,
        listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        switchAgent: (agentId) => {
          session.activeAgentId = agentId;
          session.threadId = resumeThreadId ?? null;
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

  it("releases ephemeral Reviewer sessions without retaining runtime state", () => {
    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(987654, "/tmp/reviewer", false, { lifecycle: "ephemeral" }) as unknown as FakeSession;
    session.threadId = "reviewer-thread";
    manager.setUserModel(987654, "reviewer-model");
    manager.releaseEphemeralSession(987654);

    assert.equal(manager.hasSession(987654), false);
    assert.equal(session.resetCalls, 1);
    assert.equal(manager.getSavedThreadId(987654), undefined);
  });

  it("does not delete durable thread state when an ephemeral Reviewer user id collides", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ephemeral-collision-"));
    const storage = new ThreadStorage({
      namespace: "ephemeral-collision",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    storage.setRecord(987654, {
      threadId: "durable-codex-thread",
      cwd: directory,
      agentThreads: { codex: "durable-codex-thread" },
      activeAgentId: "codex",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
    });
    const sessions = createFakeSessionFactory();
    const scopedManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      undefined,
      { createSession: sessions.factory as never },
    );

    try {
      scopedManager.getOrCreate(987654, directory, false, { lifecycle: "ephemeral" });
      scopedManager.releaseEphemeralSession(987654);

      assert.equal(storage.getRecord(987654)?.threadId, "durable-codex-thread");
      assert.deepEqual(storage.getRecord(987654)?.agentThreads, { codex: "durable-codex-thread" });
    } finally {
      scopedManager.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a durable Codex thread with a Native execution id", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-codex-native-save-"));
    const storage = new ThreadStorage({
      namespace: "codex-native-save",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    storage.setRecord(6, {
      threadId: "durable-codex-thread",
      cwd: directory,
      agentThreads: { codex: "durable-codex-thread" },
      activeAgentId: "codex",
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
    });
    const sessions = createFakeSessionFactory();
    const scopedManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      undefined,
      { createSession: sessions.factory as never },
    );

    try {
      scopedManager.getOrCreate(6, directory, false);
      scopedManager.saveThreadId(6, "native-execution-id");

      assert.equal(storage.getRecord(6)?.threadId, "durable-codex-thread");
      assert.deepEqual(storage.getRecord(6)?.agentThreads, { codex: "durable-codex-thread" });
    } finally {
      scopedManager.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records the runtime backend without persisting Native execution ids", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-state-"));
    const storage = new ThreadStorage({
      namespace: "native-runtime",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    const sessions = createFakeSessionFactory();
    const nativeManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { createSession: sessions.factory as never },
    );

    try {
      const session = nativeManager.getOrCreate(1, directory) as unknown as FakeSession;
      session.threadId = "native-execution-id";
      nativeManager.saveThreadId(1, session.threadId);

      const record = storage.getRecord(1);
      assert.equal(record?.runtimeBackend, "native");
      assert.equal(record?.lifecycle, "durable");
      assert.equal(record?.threadId, undefined);
      assert.deepEqual(record?.agentThreads, {});
    } finally {
      nativeManager.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not persist ephemeral session state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ephemeral-state-"));
    const storage = new ThreadStorage({
      namespace: "ephemeral-runtime",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    const sessions = createFakeSessionFactory();
    const ephemeralManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      undefined,
      { createSession: sessions.factory as never },
    );

    try {
      const session = ephemeralManager.getOrCreate(2, directory, false, { lifecycle: "ephemeral" }) as unknown as FakeSession;
      session.threadId = "ephemeral-thread";
      ephemeralManager.saveThreadId(2, session.threadId);
      ephemeralManager.setUserModel(2, "ephemeral-model");
      assert.equal(storage.getRecord(2), undefined);
    } finally {
      ephemeralManager.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows cross-runtime continuation via history injection and updates stored backend metadata", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-runtime-mismatch-"));
    const storage = new ThreadStorage({
      namespace: "runtime-mismatch",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    storage.setRecord(3, {
      threadId: "native-thread",
      cwd: directory,
      agentThreads: { codex: "native-thread" },
      runtimeBackend: "native",
      lifecycle: "durable",
    });
    const sessions = createFakeSessionFactory();
    const codexManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      undefined,
      { createSession: sessions.factory as never },
    );

    try {
      const session = codexManager.getOrCreate(3, directory, true) as unknown as FakeSession;
      assert.equal(session.threadId, null);
      assert.equal(codexManager.getContextRestoreMode(3), "history_injection");
      assert.equal(codexManager.needsHistoryInjection(3), true);
      assert.equal(storage.getRecord(3)?.runtimeBackend, "codex-app-server");
      assert.equal(storage.getRecord(3)?.threadId, undefined);
      assert.deepEqual(storage.getRecord(3)?.agentThreads, {});
    } finally {
      codexManager.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears ambiguous legacy thread bindings before recording backend metadata", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-legacy-runtime-"));
    const storage = new ThreadStorage({
      namespace: "legacy-runtime",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    storage.setRecord(4, {
      threadId: "native-execution-id",
      cwd: directory,
      agentThreads: { codex: "native-execution-id" },
    });
    const sessions = createFakeSessionFactory();
    const firstManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      undefined,
      { createSession: sessions.factory as never },
    );

    try {
      firstManager.getOrCreate(4, directory, true);
      firstManager.destroy();

      const adopted = storage.getRecord(4);
      assert.equal(adopted?.runtimeBackend, "codex-app-server");
      assert.equal(adopted?.threadId, undefined);
      assert.deepEqual(adopted?.agentThreads, {});

      const secondManager = new SessionManager(
        0,
        0,
        "workspace-write",
        undefined,
        storage,
        undefined,
        { createSession: sessions.factory as never },
      );
      try {
        const restored = secondManager.getOrCreate(4, directory, true) as unknown as FakeSession;
        assert.equal(restored.threadId, null);
      } finally {
        secondManager.destroy();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not preserve Native execution ids across reset", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-reset-"));
    const storage = new ThreadStorage({
      namespace: "native-reset",
      stateDbPath: path.join(directory, "state.db"),
      storagePath: path.join(directory, "threads.json"),
      saltPath: path.join(directory, "salt"),
    });
    const sessions = createFakeSessionFactory();
    const nativeManager = new SessionManager(
      0,
      0,
      "workspace-write",
      undefined,
      storage,
      { ADS_AGENT_RUNTIME: "native", ADS_WEB_SESSION_PEPPER: "test-only-pepper" },
      { createSession: sessions.factory as never },
    );

    try {
      const session = nativeManager.getOrCreate(5, directory) as unknown as FakeSession;
      session.threadId = "native-execution-id";
      nativeManager.reset(5, { preserveThreadForResume: true });

      assert.equal(nativeManager.getSavedResumeThreadId(5), undefined);
      assert.equal(storage.getRecord(5)?.threadId, undefined);
      assert.deepEqual(storage.getRecord(5)?.agentThreads ?? {}, {});
    } finally {
      nativeManager.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

  it("preserves session continuity when changing the model", () => {
    const session = manager.getOrCreate(123456, "/tmp/a") as unknown as FakeSession;
    session.threadId = "thread-before-model-change";

    manager.setUserModel(123456, "model-override");

    assert.equal(session.threadId, "thread-before-model-change");
    assert.equal(manager.needsHistoryInjection(123456), false);
    assert.equal(manager.getContextRestoreMode(123456), "fresh");
  });

  it("clears only the active agent thread when its provider cannot switch models in place", () => {
    const session = manager.getOrCreate(123456, "/tmp/a") as unknown as FakeSession;
    session.threadId = "thread-before-model-change";
    session.getAdapter = () => ({ preservesThreadOnModelChange: false });

    manager.setUserModel(123456, "model-override");

    assert.equal(session.threadId, "thread-before-model-change");
    assert.equal(manager.needsHistoryInjection(123456), true);
  });

  it("rejects switching to unsupported non-codex agents in unified engine", () => {
    manager.getOrCreate(123456, "/tmp/a");
    const result = manager.switchAgent(123456, "claude");
    assert.equal(result.success, false);
    assert.match(result.message, /不支持代理/);
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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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
      agentThreads: { codex: "codex-thread" },
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
      activeAgentId: "codex",
    });

    const sessions = createFakeSessionFactory();
    manager.destroy();
    manager = new SessionManager(1000, 500, "workspace-write", undefined, storage, undefined, {
      createSession: sessions.factory as never,
    });

    const session = manager.getOrCreate(42, "/tmp/project", true) as unknown as FakeSession;
    assert.equal(session.getModel(), "gpt-5.6-sol");
    assert.equal(session.getModelReasoningEffort(), "xhigh");
    assert.equal(session.getActiveAgentId(), "codex");
    assert.equal(session.getThreadId(), "codex-thread");
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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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
      agentThreads: { codex: "codex-thread" },
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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
    assert.equal(storage.getRecord(42)?.agentThreads?.codex, "codex-thread");
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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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

  it("preserves saved thread bindings and updates model metadata on model switch", () => {
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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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
    assert.equal(record?.threadId, "thread-1");
    assert.deepEqual(record?.agentThreads, { codex: "thread-1" });
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
      runtimeBackend: "codex-app-server",
      lifecycle: "durable",
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

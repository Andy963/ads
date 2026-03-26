import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "../../server/telegram/utils/sessionManager.js";

type FakeSession = {
  readonly id: number;
  resetCalls: number;
  workingDirectory?: string;
  send: () => Promise<{ response: string }>;
  onEvent: () => () => void;
  getThreadId: () => string | null;
  reset: () => void;
  setModel: () => void;
  setWorkingDirectory: (workingDirectory?: string) => void;
  status: () => { ready: boolean; streaming: boolean };
  getActiveAgentId: () => string;
  listAgents: () => Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }>;
  switchAgent: () => void;
};

function createFakeSessionFactory() {
  let nextId = 1;
  const created: FakeSession[] = [];

  return {
    created,
    factory: ({ cwd }: { cwd: string }) => {
      const session: FakeSession = {
        id: nextId++,
        resetCalls: 0,
        workingDirectory: cwd,
        send: async () => ({ response: "ok" }),
        onEvent: () => () => {},
        getThreadId: () => null,
        reset: () => {
          session.resetCalls += 1;
        },
        setModel: () => {},
        setWorkingDirectory: (workingDirectory) => {
          session.workingDirectory = workingDirectory;
        },
        status: () => ({ ready: true, streaming: true }),
        getActiveAgentId: () => "codex",
        listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: true } }],
        switchAgent: () => {},
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

  afterEach(() => {
    manager?.destroy();
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
});

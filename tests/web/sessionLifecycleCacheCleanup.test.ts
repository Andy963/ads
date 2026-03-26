import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { createSessionCacheRegistry } from "../../server/web/server/ws/sessionCacheRegistry.js";
import { loadCwdStore, persistCwdStore } from "../../server/web/utils.js";

type FakeSession = {
  resetCalls: number;
  reset: () => void;
  send: () => Promise<{ response: string }>;
  onEvent: () => () => void;
  getThreadId: () => string | null;
  setModel: () => void;
  setWorkingDirectory: () => void;
  status: () => { ready: boolean; streaming: boolean };
  getActiveAgentId: () => string;
  listAgents: () => Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }>;
  switchAgent: () => void;
};

function createFakeSessionFactory() {
  const created: FakeSession[] = [];
  return {
    created,
    factory: () => {
      const session: FakeSession = {
        resetCalls: 0,
        reset: () => {
          session.resetCalls += 1;
        },
        send: async () => ({ response: "ok" }),
        onEvent: () => () => {},
        getThreadId: () => null,
        setModel: () => {},
        setWorkingDirectory: () => {},
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

describe("web session lifecycle cache cleanup", () => {
  let tmpDir: string;
  let stateDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-session-cache-"));
    stateDbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = stateDbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    delete process.env.ADS_STATE_DB_PATH;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("clears cwd keys on drop and only removes the shared workspace cache after the last bound lane is gone", () => {
    const workspaceCache = new Map([["user::session", "/workspace"]]);
    const cwdStore = new Map([
      ["101", "/workspace/worker"],
      ["1001", "/workspace/worker-legacy"],
      ["202", "/workspace/planner"],
      ["2002", "/workspace/planner-legacy"],
    ]);
    const persistedSnapshots: Array<Array<[string, string]>> = [];

    const workerSessions = createFakeSessionFactory();
    const plannerSessions = createFakeSessionFactory();
    const managers: { worker?: SessionManager; planner?: SessionManager } = {};
    const registry = createSessionCacheRegistry({
      workspaceCache,
      cwdStore,
      cwdStorePath: stateDbPath,
      persistCwdStore: (_storePath, store) => {
        persistedSnapshots.push(Array.from(store.entries()));
      },
      hasActiveSession: (userId) => Boolean(managers.worker?.hasSession(userId) || managers.planner?.hasSession(userId)),
    });

    const workerManager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      createSession: workerSessions.factory as never,
      onDispose: ({ userId }) => registry.clearForUser(userId),
    });
    const plannerManager = new SessionManager(1000, 500, "read-only", undefined, undefined, undefined, {
      createSession: plannerSessions.factory as never,
      onDispose: ({ userId }) => registry.clearForUser(userId),
    });
    managers.worker = workerManager;
    managers.planner = plannerManager;

    try {
      registry.registerBinding({ userId: 101, cacheKey: "user::session", cwdKeys: ["101", "1001"] });
      registry.registerBinding({ userId: 202, cacheKey: "user::session", cwdKeys: ["202", "2002"] });

      workerManager.getOrCreate(101, "/workspace/worker", false);
      plannerManager.getOrCreate(202, "/workspace/planner", false);

      workerManager.dropSession(101);
      assert.equal(workerSessions.created[0]?.resetCalls, 1);
      assert.equal(cwdStore.has("101"), false);
      assert.equal(cwdStore.has("1001"), false);
      assert.equal(workspaceCache.get("user::session"), "/workspace");

      plannerManager.dropSession(202);
      assert.equal(plannerSessions.created[0]?.resetCalls, 1);
      assert.equal(cwdStore.has("202"), false);
      assert.equal(cwdStore.has("2002"), false);
      assert.equal(workspaceCache.has("user::session"), false);
      assert.equal(persistedSnapshots.length, 2);
    } finally {
      workerManager.destroy();
      plannerManager.destroy();
    }
  });

  it("persists cwd deletions for sqlite-backed stores", () => {
    const cwdStore = new Map<string, string>([
      ["101", "/workspace/worker"],
      ["202", "/workspace/planner"],
    ]);

    persistCwdStore(stateDbPath, cwdStore);
    cwdStore.delete("101");
    persistCwdStore(stateDbPath, cwdStore);

    assert.deepEqual(Array.from(loadCwdStore(stateDbPath).entries()), [["202", "/workspace/planner"]]);
  });
});

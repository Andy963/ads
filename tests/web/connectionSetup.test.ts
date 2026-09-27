import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../../server/sessions/sessionManager.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { extractMultipartFile } from "../../server/web/multipart.js";
import { deriveLegacyWebUserId, deriveWebUserId, loadCwdStore, persistCwdStore } from "../../server/web/utils.js";
import { listenServer } from "../../server/web/server/listenServer.js";
import { buildWsConnectionIdentity } from "../../server/web/server/ws/connectionIdentity.js";
import { restoreConnectionWorkspace } from "../../server/web/server/ws/connectionWorkspace.js";
import { createSessionCacheRegistry } from "../../server/web/server/ws/sessionCacheRegistry.js";

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

describe("web/ws/connectionIdentity", () => {
  it("builds stable websocket connection identity fields from auth/session inputs", () => {
    const identity = buildWsConnectionIdentity({
      authUserId: "user-a",
      sessionId: "session-1",
      chatSessionId: "main",
      randomHex: () => "abc123",
    });

    assert.deepEqual(identity, {
      authUserId: "user-a",
      chatKey: "session-1:main",
      legacyUserId: deriveLegacyWebUserId("user-a", "session-1:main"),
      userId: deriveWebUserId("user-a", "session-1:main"),
      historyKey: "user-a::session-1::main",
      connectionId: "abc123",
      cacheKey: "user-a::session-1",
      clientMeta: {
        historyKey: "user-a::session-1::main",
        sessionId: "session-1",
        chatSessionId: "main",
        connectionId: "abc123",
        authUserId: "user-a",
        sessionUserId: deriveWebUserId("user-a", "session-1:main"),
      },
    });
  });
});

describe("web/ws/connectionWorkspace", () => {
  it("restores the preferred project cwd without using legacy keys", () => {
    const persisted: Array<Array<[string, string]>> = [];
    const sessionManagerCalls: string[] = [];
    let currentCwd = "/workspace/root";
    const cwdStore = new Map<string, string>([["1001", "/workspace/legacy"]]);
    const workspaceCache = new Map<string, string>([["user::session", "/workspace/cached"]]);

    const result = restoreConnectionWorkspace({
      userId: 101,
      cacheKey: "user::session",
      preferredProjectCwd: "/workspace/project",
      directoryManager: {
        getUserCwd: () => currentCwd,
        setUserCwd: (_userId: number, value: string) => {
          currentCwd = value;
          return { success: true };
        },
      } as any,
      sessionManager: {
        getSavedState: () => ({ cwd: "/workspace/saved" }),
        setUserCwd: (_userId: number, value: string) => {
          sessionManagerCalls.push(value);
        },
      } as any,
      workspaceCache,
      cwdStore,
      cwdStorePath: "/tmp/state.db",
      persistCwdStore: (_storePath, store) => {
        persisted.push(Array.from(store.entries()));
      },
      warn: () => {},
    });

    assert.equal(result, "/workspace/project");
    assert.equal(cwdStore.get("101"), "/workspace/project");
    assert.equal(cwdStore.get("1001"), "/workspace/legacy");
    assert.equal(workspaceCache.get("user::session"), "/workspace/project");
    assert.deepEqual(sessionManagerCalls, ["/workspace/project"]);
    assert.equal(persisted.length, 2);
  });

  it("falls back to current cwd when preferred restoration fails", () => {
    const warnings: string[] = [];
    const sessionManagerCalls: string[] = [];
    const cwdStore = new Map<string, string>([["202", "/workspace/stored"]]);
    const workspaceCache = new Map<string, string>();

    const result = restoreConnectionWorkspace({
      userId: 202,
      cacheKey: "user::session",
      preferredProjectCwd: null,
      directoryManager: {
        getUserCwd: () => "/workspace/root",
        setUserCwd: () => ({ success: false, error: "denied" }),
      } as any,
      sessionManager: {
        getSavedState: () => ({ cwd: "/workspace/saved" }),
        setUserCwd: (_userId: number, value: string) => {
          sessionManagerCalls.push(value);
        },
      } as any,
      workspaceCache,
      cwdStore,
      cwdStorePath: "/tmp/state.db",
      persistCwdStore: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
    });

    assert.equal(result, "/workspace/root");
    assert.equal(workspaceCache.get("user::session"), "/workspace/root");
    assert.deepEqual(sessionManagerCalls, ["/workspace/root"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /WorkspaceRestore/);
  });
});

describe("web/server/listenServer", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("rejects when the target host and port are already in use", async () => {
    const first = http.createServer((_req, res) => res.end("ok"));
    servers.push(first);
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", () => resolve()));

    const address = first.address();
    assert.ok(address && typeof address === "object");

    const second = http.createServer((_req, res) => res.end("ok"));
    servers.push(second);

    await assert.rejects(() => listenServer(second, address.port, "127.0.0.1"), {
      code: "EADDRINUSE",
    });
  });
});

function makeTinyPng(): Buffer {
  const buf = Buffer.alloc(8 + 4 + 4 + 13 + 4);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(1, 16);
  buf.writeUInt32BE(1, 20);
  return buf;
}

describe("web/multipart", () => {
  it("extractMultipartFile should parse file field", () => {
    const boundary = "----ads-test-boundary";
    const file = makeTinyPng();
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        `Content-Type: image/png\r\n` +
        `\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, file, tail]);
    const part = extractMultipartFile(body, `multipart/form-data; boundary=${boundary}`, "file");
    assert.ok(part);
    assert.equal(part.fieldName, "file");
    assert.equal(part.filename, "a.png");
    assert.equal(part.contentType, "image/png");
    assert.equal(part.data.length, file.length);
    assert.ok(part.data.equals(file));
  });
});

describe("web/utils deriveWebUserId", () => {
  it("derives a stable 48-bit userId with a dedicated prefix", () => {
    const token = "t";
    const session = "s";

    const base = `${token}::${session}`;
    const hash = crypto.createHash("sha256").update(base).digest();
    const expected = 0x700000000000 + hash.readUIntBE(0, 6);

    const first = deriveWebUserId(token, session);
    const second = deriveWebUserId(token, session);

    assert.equal(first, expected);
    assert.equal(second, expected);
    assert.ok(Number.isSafeInteger(first));
    assert.ok(first >= 0x700000000000);
  });

  it("keeps legacy 32-bit derivation available for migration", () => {
    const token = "t";
    const session = "s";
    const base = `${token}::${session}`;
    const hash = crypto.createHash("sha256").update(base).digest();
    const expected = 0x70000000 + hash.readUInt32BE(0);

    const legacy = deriveLegacyWebUserId(token, session);
    assert.equal(legacy, expected);
    assert.ok(Number.isSafeInteger(legacy));
    assert.ok(legacy < 0x700000000000);
  });
});

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
      ["202", "/workspace/advisor"],
      ["2002", "/workspace/advisor-legacy"],
    ]);
    const persistedSnapshots: Array<Array<[string, string]>> = [];

    const workerSessions = createFakeSessionFactory();
    const advisorSessions = createFakeSessionFactory();
    const managers: { worker?: SessionManager; advisor?: SessionManager } = {};
    const registry = createSessionCacheRegistry({
      workspaceCache,
      cwdStore,
      cwdStorePath: stateDbPath,
      persistCwdStore: (_storePath, store) => {
        persistedSnapshots.push(Array.from(store.entries()));
      },
      hasActiveSession: (userId) => Boolean(managers.worker?.hasSession(userId) || managers.advisor?.hasSession(userId)),
    });

    const workerManager = new SessionManager(1000, 500, "workspace-write", undefined, undefined, undefined, {
      createSession: workerSessions.factory as never,
      onDispose: ({ userId }) => registry.clearForUser(userId),
    });
    const advisorManager = new SessionManager(1000, 500, "read-only", undefined, undefined, undefined, {
      createSession: advisorSessions.factory as never,
      onDispose: ({ userId }) => registry.clearForUser(userId),
    });
    managers.worker = workerManager;
    managers.advisor = advisorManager;

    try {
      registry.registerBinding({ userId: 101, cacheKey: "user::session", cwdKeys: ["101", "1001"] });
      registry.registerBinding({ userId: 202, cacheKey: "user::session", cwdKeys: ["202", "2002"] });

      workerManager.getOrCreate(101, "/workspace/worker", false);
      advisorManager.getOrCreate(202, "/workspace/advisor", false);

      workerManager.dropSession(101);
      assert.equal(workerSessions.created[0]?.resetCalls, 1);
      assert.equal(cwdStore.has("101"), false);
      assert.equal(cwdStore.has("1001"), false);
      assert.equal(workspaceCache.get("user::session"), "/workspace");

      advisorManager.dropSession(202);
      assert.equal(advisorSessions.created[0]?.resetCalls, 1);
      assert.equal(cwdStore.has("202"), false);
      assert.equal(cwdStore.has("2002"), false);
      assert.equal(workspaceCache.has("user::session"), false);
      assert.equal(persistedSnapshots.length, 2);
    } finally {
      workerManager.destroy();
      advisorManager.destroy();
    }
  });

  it("persists cwd deletions for sqlite-backed stores", () => {
    const cwdStore = new Map<string, string>([
      ["101", "/workspace/worker"],
      ["202", "/workspace/advisor"],
    ]);

    persistCwdStore(stateDbPath, cwdStore);
    cwdStore.delete("101");
    persistCwdStore(stateDbPath, cwdStore);

    assert.deepEqual(Array.from(loadCwdStore(stateDbPath).entries()), [["202", "/workspace/advisor"]]);
  });
});

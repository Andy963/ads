import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { DirectoryManager } from "../../server/telegram/utils/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";

type AuthStub = {
  authenticateRequest?: (req: http.IncomingMessage) => { ok: false } | { ok: true; userId: string; tokenHash?: string };
  revalidateSession?: (tokenHash: string) => boolean;
};

type ConfigStub = {
  pingIntervalMs?: number;
  maxMissedPongs?: number;
  maxPayloadBytes?: number;
};

describe("web/server/ws security hardening", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const servers: http.Server[] = [];
  const wssList: import("ws").WebSocketServer[] = [];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-security-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-security-ws-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(async () => {
    for (const wss of wssList) {
      try {
        wss.close();
      } catch {
        // ignore
      }
    }
    for (const server of servers) {
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    servers.length = 0;
    wssList.length = 0;
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    for (const dir of [tmpDir, workspaceRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  async function start(t: { skip: (msg?: string) => void }, config: ConfigStub, auth: AuthStub): Promise<number | null> {
    const server = http.createServer();
    servers.push(server);
    const workerSessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    const plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    const lock = new AsyncLock();

    const wss = attachWebSocketServer({
      server,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      config: {
        workspaceRoot,
        allowedDirs: [workspaceRoot],
        maxClients: 0,
        pingIntervalMs: config.pingIntervalMs ?? 0,
        maxMissedPongs: config.maxMissedPongs ?? 0,
        maxPayloadBytes: config.maxPayloadBytes,
        traceWsDuplication: false,
      },
      auth: {
        allowedOrigins: new Set(),
        isOriginAllowed: () => true,
        authenticateRequest: auth.authenticateRequest ?? (() => ({ ok: true, userId: "test" })),
        revalidateSession: auth.revalidateSession,
      },
      agents: { agentAvailability: new NoopAgentAvailability() },
      state: {
        directoryManager: new DirectoryManager([workspaceRoot]),
        workspaceCache: new Map(),
        sessionCacheRegistry: { registerBinding: () => {}, clearForUser: () => {} },
        interruptControllers: new Map<string, AbortController>(),
        promptRunEpochs: new Map<string, number>(),
        clientMetaByWs: new Map(),
        clients: new Set(),
        cwdStore: new Map(),
        cwdStorePath: process.env.ADS_STATE_DB_PATH as string,
        persistCwdStore: () => {},
      },
      sessions: {
        workerSessionManager,
        plannerSessionManager,
        getWorkspaceLock: () => lock,
        getPlannerWorkspaceLock: () => lock,
      },
      history: { workerHistoryStore, plannerHistoryStore },
      tasks: {
        ensureTaskContext: () => ({}) as never,
        promoteQueuedTasksToPending: () => {},
        broadcastToSession: () => {},
      },
      commands: {
        runAdsCommandLine: async () => ({ ok: true, output: "" }),
        sanitizeInput: (payload) => String(payload ?? ""),
        syncWorkspaceTemplates: () => {},
      },
      scheduler: {},
    });
    wssList.push(wss);

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => resolve());
        server.once("error", reject);
      });
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "EPERM" || code === "EACCES") {
        t.skip(`listen not permitted (${code})`);
        return null;
      }
      throw error;
    }
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    return addr.port;
  }

  function connect(port: number): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}`, ["ads-v1", "ads-session.test", "ads-chat.main"], {
      origin: "http://localhost",
    });
  }

  it("closes the connection when a frame exceeds maxPayloadBytes", async (t) => {
    const port = await start(t, { maxPayloadBytes: 1024 }, {});
    if (port === null) return;

    const client = connect(port);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", (err) => reject(err));
      setTimeout(() => reject(new Error("open timeout")), 1500);
    });

    const closePromise = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });
    // Oversized frame (well beyond the 1024-byte cap).
    client.send("x".repeat(8192));

    const code = await Promise.race([
      closePromise,
      new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error("close timeout")), 1500)),
    ]);
    assert.equal(code, 1009, "expected close code 1009 (message too big)");
  });

  it("terminates a connection whose session is no longer valid", async (t) => {
    const port = await start(
      t,
      { pingIntervalMs: 40, maxMissedPongs: 3 },
      {
        authenticateRequest: () => ({ ok: true, userId: "test", tokenHash: "hash-1" }),
        revalidateSession: () => false,
      },
    );
    if (port === null) return;

    const client = connect(port);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", (err) => reject(err));
      setTimeout(() => reject(new Error("open timeout")), 1500);
    });

    const code = await Promise.race([
      new Promise<number>((resolve) => client.once("close", (c) => resolve(c))),
      new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error("close timeout")), 2000)),
    ]);
    assert.equal(code, 4401, "expected close code 4401 for revoked/expired session");
  });

  it("keeps a connection open while its session stays valid", async (t) => {
    const port = await start(
      t,
      { pingIntervalMs: 40, maxMissedPongs: 5 },
      {
        authenticateRequest: () => ({ ok: true, userId: "test", tokenHash: "hash-1" }),
        revalidateSession: () => true,
      },
    );
    if (port === null) return;

    const client = connect(port);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", (err) => reject(err));
      setTimeout(() => reject(new Error("open timeout")), 1500);
    });

    let closedCode: number | null = null;
    client.once("close", (c) => {
      closedCode = c;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(closedCode, null, "valid session should not be terminated by revalidation");
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
  });
});

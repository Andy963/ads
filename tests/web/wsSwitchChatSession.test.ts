import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { DirectoryManager } from "../../server/telegram/utils/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";

type WsJson = { type?: unknown; [k: string]: unknown };

function waitForWsOpen(client: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ws open")), timeoutMs);
    client.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForWsMessage(client: WebSocket, predicate: (msg: WsJson) => boolean, timeoutMs = 2000): Promise<WsJson> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ws message")), timeoutMs);
    const handler = (raw: RawData) => {
      let parsed: WsJson | null = null;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as WsJson;
      } catch {
        return;
      }
      if (!predicate(parsed)) {
        return;
      }
      clearTimeout(timer);
      client.off("message", handler);
      resolve(parsed);
    };
    client.on("message", handler);
    client.once("error", (err) => {
      clearTimeout(timer);
      client.off("message", handler);
      reject(err);
    });
  });
}

function createFakeSessionFactory(prefix: string) {
  let nextId = 1;
  const created: any[] = [];

  return {
    created,
    factory: ({ cwd }: { cwd: string }) => {
      const session = {
        resetCalls: 0,
        threadId: `${prefix}-thread-${nextId++}`,
        workingDirectory: cwd,
        send: async () => ({ response: "ok" }),
        onEvent: () => () => {},
        getThreadId: () => session.threadId,
        reset: () => {
          session.resetCalls += 1;
          session.threadId = null;
        },
        setModel: () => {},
        setWorkingDirectory: (workingDirectory: string, options?: { preserveSession?: boolean }) => {
          session.workingDirectory = workingDirectory;
          if (!options?.preserveSession) {
            session.threadId = null;
          }
        },
        status: () => ({ ready: true, streaming: false }),
        getActiveAgentId: () => "codex",
        listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: false } }],
        switchAgent: () => {},
      };
      created.push(session);
      return session;
    },
  };
}

describe("web/server/ws: in-band switch_chat_session", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let workspaceRoot: string;
  let workerHistoryStore: HistoryStore;
  let plannerHistoryStore: HistoryStore;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ws-switch-test-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ws-switch-ws-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests(process.env.ADS_STATE_DB_PATH);

    server = http.createServer();
    const clients = new Set<import("ws").WebSocket>();
    const clientMetaByWs = new Map<import("ws").WebSocket, any>();
    workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);
    const workerFactory = createFakeSessionFactory("worker");
    const plannerFactory = createFakeSessionFactory("planner");

    attachWebSocketServer({
      server,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      config: {
        workspaceRoot,
        allowedDirs: [workspaceRoot],
        maxClients: 10,
        pingIntervalMs: 0,
        maxMissedPongs: 0,
        traceWsDuplication: false,
      },
      auth: {
        allowedOrigins: new Set(),
        isOriginAllowed: () => true,
        authenticateRequest: () => ({ ok: true, userId: "test" }),
      },
      agents: {
        agentAvailability,
      },
      state: {
        directoryManager,
        workspaceCache: new Map(),
        sessionCacheRegistry: { registerBinding: () => {}, clearForUser: () => {} },
        interruptControllers: new Map<string, AbortController>(),
        clientMetaByWs,
        clients,
        cwdStore: new Map(),
        cwdStorePath: process.env.ADS_STATE_DB_PATH,
        persistCwdStore: () => {},
      },
      sessions: {
        workerSessionManager: new SessionManager(0, 0, "workspace-write", "test-model", undefined, undefined, {
          createSession: workerFactory.factory as never,
        }),
        plannerSessionManager: new SessionManager(0, 0, "read-only", "test-model", undefined, undefined, {
          createSession: plannerFactory.factory as never,
        }),
        getWorkspaceLock: () => lock,
        getPlannerWorkspaceLock: () => lock,
      },
      history: {
        workerHistoryStore,
        plannerHistoryStore,
      },
      tasks: {
        ensureTaskContext: () => ({} as unknown as any),
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

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
      server.once("error", reject);
    });
  });

  afterEach(async () => {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {}
    }
    sockets.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {}
  });

  it("switches chatSessionId in-band without dropping the socket connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.main", "ads-chat.session-initial"]);
    sockets.push(ws);

    let isClosed = false;
    ws.on("close", () => {
      isClosed = true;
    });

    const welcomePromise = waitForWsMessage(ws, (m) => m.type === "welcome");
    await waitForWsOpen(ws);

    const initialWelcome = await welcomePromise;
    assert.equal(initialWelcome.chatSessionId, "session-initial");

    // Send in-band switch message and wait for new welcome
    const switchPromise = waitForWsMessage(ws, (m) => m.type === "welcome" && m.chatSessionId === "session-switched");
    ws.send(JSON.stringify({
      type: "switch_chat_session",
      payload: { chatSessionId: "session-switched" },
    }));

    const switchedWelcome = await switchPromise;
    assert.equal(switchedWelcome.chatSessionId, "session-switched");

    // Connection must have remained open
    assert.equal(isClosed, false);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });
});

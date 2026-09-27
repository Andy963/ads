import { describe, it, beforeEach, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import type { WsClientMeta } from "../../server/web/server/ws/deps.js";
import { resolveSyncLaneKey, resolveSyncNamespace } from "../../server/web/server/sync/lane.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";

type WsJson = { type?: unknown; [k: string]: unknown };

const originalEnv = { ...process.env };

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

function waitForWsMessage(
  client: WebSocket,
  predicate: (msg: WsJson) => boolean,
  timeoutMs = 2000,
  label = "",
): Promise<WsJson> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ws message${label ? `: ${label}` : ""}`)),
      timeoutMs,
    );
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

type StartedWsServer = {
  server: http.Server;
  wss: ReturnType<typeof attachWebSocketServer>;
  port: number;
  tmpDir: string;
  workspaceRoot: string;
  workerHistoryStore: HistoryStore;
  advisorHistoryStore: HistoryStore;
  syncEventStore?: SyncEventStore;
};

type StartWsServerOptions = {
  maxClients: number;
  pingIntervalMs: number;
  maxMissedPongs: number;
  authenticateRequest?: (req: http.IncomingMessage) => { ok: true; userId: string };
  workerSessionManager?: SessionManager;
  advisorSessionManager?: SessionManager;
  withSyncEventStore?: boolean;
};

async function startWsServer(options: StartWsServerOptions, t?: TestContext): Promise<StartedWsServer | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-connection-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-workspace-"));
  process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
  resetStateDatabaseForTests();

  const server = http.createServer();
  const clients = new Set<WebSocket>();
  const clientMetaByWs = new Map<WebSocket, WsClientMeta>();
  const workerSessionManager =
    options.workerSessionManager ?? new SessionManager(0, 0, "workspace-write", "test-model");
  const advisorSessionManager =
    options.advisorSessionManager ?? new SessionManager(0, 0, "read-only", "test-model");
  const workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
  const advisorHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-advisor" });
  const lock = new AsyncLock();
  const agentAvailability = new NoopAgentAvailability();
  const directoryManager = new DirectoryManager([workspaceRoot]);
  const syncEventStore = options.withSyncEventStore
    ? new SyncEventStore({ stateDbPath: process.env.ADS_STATE_DB_PATH })
    : undefined;

  const wss = attachWebSocketServer({
    server,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    config: {
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      maxClients: options.maxClients,
      pingIntervalMs: options.pingIntervalMs,
      maxMissedPongs: options.maxMissedPongs,
      traceWsDuplication: false,
    },
    auth: {
      allowedOrigins: new Set(),
      isOriginAllowed: () => true,
      authenticateRequest: options.authenticateRequest ?? (() => ({ ok: true, userId: "test" })),
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
      ...(syncEventStore ? { syncEventStore } : {}),
    },
    sessions: {
      workerSessionManager,
      advisorSessionManager,
      getWorkspaceLock: () => lock,
      getAdvisorWorkspaceLock: () => lock,
    },
    history: {
      workerHistoryStore,
      advisorHistoryStore,
    },
    tasks: {
      ensureTaskContext: () => ({} as unknown as any),
      promoteQueuedTasksToPending: () => {},
      broadcastToSession: () => {},
    },
    commands: {
      runAdsCommandLine: async () => ({ ok: true, output: "" }),
      sanitizeInput: (payload) => String(payload ?? ""),
    },
    scheduler: {},
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (t && (code === "EPERM" || code === "EACCES")) {
      t.skip(`listen not permitted (${code})`);
      return null;
    }
    throw error;
  }

  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return {
    server,
    wss,
    port: addr.port,
    tmpDir,
    workspaceRoot,
    workerHistoryStore,
    advisorHistoryStore,
    syncEventStore,
  };
}

async function stopWsServer(started: StartedWsServer | null): Promise<void> {
  if (!started) {
    return;
  }
  try {
    started.wss.close();
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    try {
      started.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
  resetStateDatabaseForTests();
  process.env = { ...originalEnv };
  try {
    fs.rmSync(started.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    fs.rmSync(started.workspaceRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function createFakeSessionFactory(prefix: string, options: { blockFirstSend?: boolean } = {}) {
  let nextId = 1;
  let firstSend = true;
  let resolveFirstSendStarted: (() => void) | null = null;
  let releaseFirstSend: (() => void) | null = null;
  const firstSendStarted = new Promise<void>((resolve) => {
    resolveFirstSendStarted = resolve;
  });
  const firstSendGate = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });
  const created: any[] = [];

  return {
    created,
    factory: ({ cwd }: { cwd: string }) => {
      let resetCalls = 0;
      let threadId: string | null = `${prefix}-thread-${nextId++}`;
      let workingDirectory = cwd;
      const adapter = {
        id: "codex" as const,
        metadata: { id: "codex" as const, name: "Codex", capabilities: ["text" as const] },
        send: async (input: unknown) => {
          if (options.blockFirstSend && firstSend) {
            firstSend = false;
            resolveFirstSendStarted?.();
            await firstSendGate;
          }
          const inputText = typeof input === "string" ? input : "";
          const response = inputText.includes("first prompt")
            ? "first response"
            : inputText.includes("second prompt")
              ? "second response"
              : "ok";
          return { response, usage: null, agentId: "codex" };
        },
        onEvent: () => () => {},
        getThreadId: () => threadId,
        reset: () => {
          resetCalls += 1;
          threadId = null;
        },
        setWorkingDirectory: (nextDirectory: string, options?: { preserveSession?: boolean }) => {
          workingDirectory = nextDirectory;
          if (!options?.preserveSession) {
            threadId = null;
          }
        },
        status: () => ({ ready: true, streaming: false }),
      };
      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        initialWorkingDirectory: workingDirectory,
        initialModel: "test-model",
      });
      created.push({ orchestrator, get resetCalls() { return resetCalls; } });
      return orchestrator;
    },
    firstSendStarted,
    releaseFirstSend: () => releaseFirstSend?.(),
  };
}

describe("web/server/ws maxClients", () => {
  let started: StartedWsServer | null = null;

  beforeEach(async (t) => {
    started = await startWsServer({ maxClients: 0, pingIntervalMs: 0, maxMissedPongs: 0 }, t);
  });

  afterEach(async () => {
    await stopWsServer(started);
    started = null;
  });

  it("treats maxClients=0 as unlimited", async () => {
    const url = `ws://127.0.0.1:${started!.port}`;
    const client = new WebSocket(url, ["ads-v1", "ads-session.test", "ads-chat.main"], { origin: "http://localhost" });

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", (err) => reject(err));
        client.once("close", (code, reason) => reject(new Error(`closed code=${code} reason=${reason.toString()}`)));
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);

    client.close();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
  });
});

describe("web/server/ws reconnect cwd restore", () => {
  let started: StartedWsServer | null = null;
  let nextWorkspace: string;

  beforeEach(async (t) => {
    started = await startWsServer(
      {
        maxClients: 10,
        pingIntervalMs: 0,
        maxMissedPongs: 0,
        authenticateRequest: (req) => {
          const header = req.headers["x-user-id"];
          const userId = Array.isArray(header) ? header[0] : header;
          return { ok: true as const, userId: String(userId ?? "default") };
        },
      },
      t,
    );
    if (started) {
      nextWorkspace = path.join(started.workspaceRoot, "nested");
      fs.mkdirSync(nextWorkspace, { recursive: true });
    }
  });

  afterEach(async () => {
    await stopWsServer(started);
    started = null;
  });

  it("restores cwd for the same identity after reconnect without leaking to another user", async () => {
    const url = `ws://127.0.0.1:${started!.port}`;
    const workspaceRoot = started!.workspaceRoot;
    const protocols = ["ads-v1", "ads-session.shared-session", "ads-chat.main"];

    const clientA = new WebSocket(url, protocols, { origin: "http://localhost", headers: { "x-user-id": "user-a" } });
    const firstWelcomePromise = waitForWsMessage(clientA, (msg) => msg.type === "welcome");
    await waitForWsOpen(clientA);
    await firstWelcomePromise;

    const cdResultPromise = waitForWsMessage(
      clientA,
      (msg) => msg.type === "result" && typeof msg.output === "string" && String(msg.output).includes(nextWorkspace),
    );
    clientA.send(JSON.stringify({ type: "command", payload: `/cd ${nextWorkspace}` }));
    await cdResultPromise;

    clientA.terminate();

    const reconnectA = new WebSocket(url, protocols, { origin: "http://localhost", headers: { "x-user-id": "user-a" } });
    const reconnectWelcomePromise = waitForWsMessage(reconnectA, (msg) => msg.type === "welcome");
    await waitForWsOpen(reconnectA);
    const welcomeA = await reconnectWelcomePromise;
    assert.equal((welcomeA.workspace as { path?: unknown }).path, nextWorkspace);

    const clientB = new WebSocket(url, protocols, { origin: "http://localhost", headers: { "x-user-id": "user-b" } });
    const otherWelcomePromise = waitForWsMessage(clientB, (msg) => msg.type === "welcome");
    await waitForWsOpen(clientB);
    const welcomeB = await otherWelcomePromise;
    assert.equal((welcomeB.workspace as { path?: unknown }).path, workspaceRoot);

    reconnectA.terminate();
    clientB.terminate();
  });
});

describe("web/server/ws stability", () => {
  let started: StartedWsServer | null = null;

  beforeEach(async (t) => {
    started = await startWsServer({ maxClients: 10, pingIntervalMs: 30, maxMissedPongs: 1 }, t);
  });

  afterEach(async () => {
    await stopWsServer(started);
    started = null;
  });

  it("terminates stale connections even if app-level messages are received", async () => {
    const url = `ws://127.0.0.1:${started!.port}`;
    const client = new WebSocket(url, ["ads-v1", "ads-session.test", "ads-chat.main"], {
      origin: "http://localhost",
      autoPong: false,
    });

    let keepAlive: ReturnType<typeof setInterval> | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", (err) => reject(err));
      });

      keepAlive = setInterval(() => {
        if (client.readyState !== WebSocket.OPEN) return;
        try {
          client.send(JSON.stringify({ type: "ping", payload: { ts: Date.now() } }));
        } catch {
          // ignore
        }
      }, 5);

      const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for stale WS termination")), 1500);
        client.once("close", (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString() });
        });
        client.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      assert.equal(closed.code, 1006);
    } finally {
      if (keepAlive) {
        clearInterval(keepAlive);
      }
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
  });
});

describe("web/server/ws in-band switch_chat_session", () => {
  let started: StartedWsServer | null = null;
  let workerFactory: ReturnType<typeof createFakeSessionFactory> | null = null;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const nextWorkerFactory = createFakeSessionFactory("worker", { blockFirstSend: true });
    workerFactory = nextWorkerFactory;
    const advisorFactory = createFakeSessionFactory("advisor");

    started = await startWsServer({
      maxClients: 10,
      pingIntervalMs: 0,
      maxMissedPongs: 0,
      workerSessionManager: new SessionManager(0, 0, "workspace-write", "test-model", undefined, undefined, {
        createSession: nextWorkerFactory.factory as never,
      }),
      advisorSessionManager: new SessionManager(0, 0, "read-only", "test-model", undefined, undefined, {
        createSession: advisorFactory.factory as never,
      }),
      withSyncEventStore: true,
    });
  });

  afterEach(async () => {
    workerFactory?.releaseFirstSend();
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    sockets.length = 0;
    await stopWsServer(started);
    started = null;
  });

  it("switches chatSessionId in-band without dropping the socket connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${started!.port}/ws`, ["ads-v1", "ads-session.main", "ads-chat.acopilot"]);
    sockets.push(ws);

    let isClosed = false;
    ws.on("close", () => {
      isClosed = true;
    });

    const welcomePromise = waitForWsMessage(ws, (m) => m.type === "welcome");
    await waitForWsOpen(ws);

    const initialWelcome = await welcomePromise;
    assert.equal(initialWelcome.chatSessionId, "acopilot");

    // Send in-band switch message and wait for new welcome
    const switchPromise = waitForWsMessage(ws, (m) => m.type === "welcome" && m.chatSessionId === "session-switched");
    ws.send(JSON.stringify({
      type: "switch_chat_session",
      payload: { chatSessionId: "session-switched" },
    }));

    const switchedWelcome = await switchPromise;
    assert.equal(switchedWelcome.chatSessionId, "session-switched");

    const errorPromise = waitForWsMessage(
      ws,
      (m) => m.type === "error" && m.message === "当前没有正在执行的任务",
    );
    ws.send(JSON.stringify({ type: "interrupt" }));
    await errorPromise;

    const switchedLaneKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "main",
      chatSessionId: "session-switched",
    });
    const initialLaneKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "main",
      chatSessionId: "acopilot",
    });
    assert.ok(started!.syncEventStore!.getLatestSeqForLanes(resolveSyncNamespace("session-switched"), [switchedLaneKey]) > 0);
    assert.equal(started!.syncEventStore!.getLatestSeqForLanes(resolveSyncNamespace("acopilot"), [initialLaneKey]), 0);

    // Connection must have remained open
    assert.equal(isClosed, false);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it("persists prompts received during a switch in the new history lane", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${started!.port}/ws`, ["ads-v1", "ads-session.main", "ads-chat.session-initial"]);
    sockets.push(ws);

    const welcomePromise = waitForWsMessage(ws, (m) => m.type === "welcome");
    await waitForWsOpen(ws);
    await welcomePromise;

    const firstAckPromise = waitForWsMessage(ws, (m) => m.type === "ack" && m.client_message_id === "first", 2000, "first ack");
    const firstResultPromise = waitForWsMessage(
      ws,
      (m) => m.type === "result" && m.output === "first response",
      2000,
      "first result",
    );
    ws.send(JSON.stringify({ type: "prompt", payload: "first prompt", client_message_id: "first" }));
    await firstAckPromise;
    await workerFactory!.firstSendStarted;

    const switchPromise = waitForWsMessage(ws, (m) => m.type === "welcome" && m.chatSessionId === "session-switched");
    ws.send(JSON.stringify({
      type: "switch_chat_session",
      payload: { chatSessionId: "session-switched" },
    }));

    const secondAckPromise = waitForWsMessage(ws, (m) => m.type === "ack" && m.client_message_id === "second", 2000, "second ack");
    const secondResultPromise = waitForWsMessage(ws, (m) => m.type === "result" && m.output === "second response", 2000, "second result");
    ws.send(JSON.stringify({ type: "prompt", payload: "second prompt", client_message_id: "second" }));
    workerFactory!.releaseFirstSend();

    await firstResultPromise;
    await switchPromise;
    await secondAckPromise;
    await secondResultPromise;

    const initialHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "main",
      chatSessionId: "session-initial",
    });
    const switchedHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "main",
      chatSessionId: "session-switched",
    });
    const initialHistory = started!.workerHistoryStore.get(initialHistoryKey);
    const switchedHistory = started!.workerHistoryStore.get(switchedHistoryKey);
    assert.equal(initialHistory.some((entry) => entry.text === "second prompt"), false);
    assert.ok(switchedHistory.some((entry) => entry.text === "second prompt"));
  });
});

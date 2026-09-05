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
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { resolveSyncLaneKey, resolveSyncNamespace } from "../../server/web/server/sync/lane.js";
import { WebLaneGenerationStore } from "../../server/web/server/sync/laneGeneration.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";

type WsJson = { type?: unknown; [k: string]: unknown };

type FakeSession = {
  resetCalls: number;
  threadId: string | null;
  workingDirectory?: string;
  send: () => Promise<{ response: string }>;
  onEvent: () => () => void;
  getThreadId: () => string | null;
  reset: () => void;
  setModel: () => void;
  setWorkingDirectory: (workingDirectory?: string, options?: { preserveSession?: boolean }) => void;
  status: () => { ready: boolean; streaming: boolean };
  getActiveAgentId: () => string;
  listAgents: () => Array<{ metadata: { id: string; name: string }; status: { ready: boolean; streaming: boolean } }>;
  switchAgent: () => void;
};

function createFakeSessionFactory(prefix: string) {
  let nextId = 1;
  const created: FakeSession[] = [];

  return {
    created,
    factory: ({ cwd }: { cwd: string }) => {
      const session: FakeSession = {
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
        setWorkingDirectory: (workingDirectory, options) => {
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
      return session as unknown as ReturnType<SessionManager["getOrCreate"]>;
    },
  };
}

function waitForWsOpen(client: WebSocket, timeoutMs = 1500): Promise<void> {
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

function waitForWsMessage(client: WebSocket, predicate: (msg: WsJson) => boolean, timeoutMs = 1500): Promise<WsJson> {
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

describe("web/server/ws/broadcast", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  let runAdsCommandLineImpl: (command: string) => Promise<{ ok: boolean; output: string }>;
  let workerSessions: FakeSession[];
  let plannerSessions: FakeSession[];
  let workerHistoryStore: HistoryStore;
  let plannerHistoryStore: HistoryStore;
  let syncEventStore: SyncEventStore;
  let laneGenerationStore: WebLaneGenerationStore;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-broadcast-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();

    runAdsCommandLineImpl = async () => ({ ok: true, output: "" });

    server = http.createServer();
    const clients = new Set<import("ws").WebSocket>();
    const clientMetaByWs = new Map<
      import("ws").WebSocket,
      {
        historyKey: string;
        sessionId: string;
        chatSessionId: string;
        connectionId: string;
        authUserId: string;
        sessionUserId: number;
        workspaceRoot?: string;
      }
    >();
    workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    syncEventStore = new SyncEventStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    laneGenerationStore = new WebLaneGenerationStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);
    const workerFactory = createFakeSessionFactory("worker");
    const plannerFactory = createFakeSessionFactory("planner");
    workerSessions = workerFactory.created;
    plannerSessions = plannerFactory.created;

    wss = attachWebSocketServer({
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
        syncEventStore,
        laneGenerationStore,
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
        runAdsCommandLine: async (command) => await runAdsCommandLineImpl(command),
        sanitizeInput: (payload) => String(payload ?? ""),
        syncWorkspaceTemplates: () => {},
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
      if (code === "EPERM" || code === "EACCES") {
        t.skip(`listen not permitted (${code})`);
        return;
      }
      throw error;
    }
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    port = addr.port;
  });

  afterEach(async () => {
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("broadcasts command results and workspace state to another active connection in the same session", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];

    let resolveRun: ((value: { ok: boolean; output: string }) => void) | null = null;
    let runStarted: (() => void) | null = null;
    const runStartedPromise = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const runPromise = new Promise<{ ok: boolean; output: string }>((resolve) => {
      resolveRun = resolve;
    });

    runAdsCommandLineImpl = async () => {
      runStarted?.();
      return await runPromise;
    };

    const clientA = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(clientA);

    clientA.send(JSON.stringify({ type: "command", payload: "echo hello" }));
    await runStartedPromise;

    const clientB = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(clientB);

    const resultPromise = waitForWsMessage(clientB, (msg) => msg.type === "result" && msg.output === "done");
    const workspacePromise = waitForWsMessage(clientB, (msg) => msg.type === "workspace");
    resolveRun?.({ ok: true, output: "done" });

    const result = await resultPromise;
    const workspace = await workspacePromise;
    assert.equal(result.type, "result");
    assert.equal(workspace.type, "workspace");

    try {
      clientA.terminate();
    } catch {
      // ignore
    }

    try {
      clientB.terminate();
    } catch {
      // ignore
    }
  });

  it("broadcasts lane clear_history resets only to sibling connections in the same chat lane", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const mainProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const customWorkerProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.worker-custom"];

    const mainClientA = new WebSocket(url, mainProtocols, { origin: "http://localhost" });
    const mainClientB = new WebSocket(url, mainProtocols, { origin: "http://localhost" });
    const customWorkerClient = new WebSocket(url, customWorkerProtocols, { origin: "http://localhost" });
    await waitForWsOpen(mainClientA);
    await waitForWsOpen(mainClientB);
    await waitForWsOpen(customWorkerClient);

    const siblingMessages: WsJson[] = [];
    const siblingHandler = (raw: RawData) => {
      try {
        siblingMessages.push(JSON.parse(raw.toString("utf8")) as WsJson);
      } catch {
        // ignore
      }
    };
    customWorkerClient.on("message", siblingHandler);

    const resetPromise = waitForWsMessage(
      mainClientB,
      (msg) => msg.type === "session_reset" && msg.source === "clear_history" && msg.sourceChatSessionId === "main",
      1500,
    );
    const resultPromise = waitForWsMessage(
      mainClientA,
      (msg) => msg.type === "result" && msg.kind === "clear_history" && msg.ok === true,
      1500,
    );

    mainClientA.send(JSON.stringify({ type: "clear_history" }));

    const reset = await resetPromise;
    const result = await resultPromise;
    assert.equal(reset.type, "session_reset");
    assert.equal(reset.seq, undefined);
    assert.equal(result.type, "result");
    const resetLane = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "main",
    });
    assert.equal(
      syncEventStore.readAfter({
        namespace: resolveSyncNamespace("main"),
        laneKey: resetLane,
        afterSeq: 0,
      }).events.some((event) => event.type === "session_reset"),
      false,
    );
    assert.equal(workerSessions[0]?.resetCalls, 1);
    assert.equal(workerSessions[1]?.resetCalls, 0);
    assert.equal(plannerSessions.length, 0);
    assert.equal(workerSessions[0]?.threadId, null);
    assert.notEqual(workerSessions[1]?.threadId, null);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      siblingMessages.filter((msg) => msg.type === "session_reset").length,
      0,
    );

    customWorkerClient.off("message", siblingHandler);
    try {
      mainClientA.terminate();
    } catch {
      // ignore
    }
    try {
      mainClientB.terminate();
    } catch {
      // ignore
    }
    try {
      customWorkerClient.terminate();
    } catch {
      // ignore
    }
  });

  it("does not allow the planner lane to reset any worker lane", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const mainProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const plannerProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.planner"];

    const mainClient = new WebSocket(url, mainProtocols, { origin: "http://localhost" });
    const plannerClient = new WebSocket(url, plannerProtocols, { origin: "http://localhost" });
    await waitForWsOpen(mainClient);
    await waitForWsOpen(plannerClient);

    const mainMessages: WsJson[] = [];
    const mainHandler = (raw: RawData) => {
      try {
        mainMessages.push(JSON.parse(raw.toString("utf8")) as WsJson);
      } catch {
        // ignore
      }
    };
    mainClient.on("message", mainHandler);

    const resetPromise = waitForWsMessage(
      plannerClient,
      (msg) => msg.type === "session_reset" && msg.sourceChatSessionId === "planner" && msg.scope === "lane",
      1500,
    );
    const resultPromise = waitForWsMessage(
      plannerClient,
      (msg) => msg.type === "result" && msg.kind === "clear_history" && msg.ok === true,
      1500,
    );

    plannerClient.send(JSON.stringify({ type: "clear_history", payload: { scope: "shared" } }));

    const reset = await resetPromise;
    const result = await resultPromise;
    assert.equal(reset.type, "session_reset");
    assert.equal(result.type, "result");
    assert.equal(workerSessions[0]?.resetCalls, 0);
    assert.equal(plannerSessions[0]?.resetCalls, 1);
    assert.equal(mainClient.readyState, WebSocket.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      mainMessages.some((msg) => msg.type === "session_reset"),
      false,
    );

    mainClient.off("message", mainHandler);
    try {
      mainClient.terminate();
    } catch {
      // ignore
    }
    try {
      plannerClient.terminate();
    } catch {
      // ignore
    }
  });

  it("resets disconnected worker lanes while keeping the planner lane isolated", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const mainProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const plannerProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.planner"];
    const customWorkerProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.worker-custom"];

    const mainClient = new WebSocket(url, mainProtocols, { origin: "http://localhost" });
    const plannerClient = new WebSocket(url, plannerProtocols, { origin: "http://localhost" });
    const customWorkerClient = new WebSocket(url, customWorkerProtocols, { origin: "http://localhost" });
    await waitForWsOpen(mainClient);
    await waitForWsOpen(plannerClient);
    await waitForWsOpen(customWorkerClient);

    workerHistoryStore.add(
      resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "main", generation: 1 }),
      { role: "user", text: "main stale", ts: Date.now() },
    );
    plannerHistoryStore.add(
      resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "planner", generation: 1 }),
      { role: "user", text: "planner stale", ts: Date.now() },
    );
    workerHistoryStore.add(
      resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "worker-custom", generation: 1 }),
      { role: "user", text: "custom stale", ts: Date.now() },
    );

    try {
      customWorkerClient.terminate();
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const resultPromise = waitForWsMessage(
      mainClient,
      (msg) => msg.type === "result" && msg.kind === "clear_history" && msg.ok === true,
      1500,
    );
    mainClient.send(JSON.stringify({ type: "clear_history", payload: { scope: "shared" } }));
    const result = await resultPromise;
    assert.equal(result.type, "result");

    assert.equal(workerSessions[0]?.resetCalls, 1);
    assert.equal(workerSessions[1]?.resetCalls, 1);
    assert.equal(plannerSessions[0]?.resetCalls, 0);
    assert.deepEqual(
      workerHistoryStore.get(
        resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "main", generation: 1 }),
      ),
      [],
    );
    assert.equal(plannerSessions[0]?.threadId === null, false);
    assert.equal(
      plannerHistoryStore.get(
        resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "planner", generation: 1 }),
      )[0]?.text,
      "planner stale",
    );
    assert.deepEqual(
      workerHistoryStore.get(
        resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "worker-custom", generation: 1 }),
      ),
      [],
    );

    const reconnectedCustomWorkerClient = new WebSocket(url, customWorkerProtocols, { origin: "http://localhost" });
    const welcomePromise = waitForWsMessage(reconnectedCustomWorkerClient, (msg) => msg.type === "welcome", 1500);
    await waitForWsOpen(reconnectedCustomWorkerClient);
    const welcome = await welcomePromise;
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.laneGeneration, 2);
    assert.equal(welcome.contextMode, "fresh");

    try {
      mainClient.terminate();
    } catch {
      // ignore
    }
    try {
      plannerClient.terminate();
    } catch {
      // ignore
    }
    try {
      reconnectedCustomWorkerClient.terminate();
    } catch {
      // ignore
    }
  });

  it("clears the current generation when a stale connection requests a reset", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(client);

    const logicalLane = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "main",
    });
    const currentLane = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "main",
      generation: 2,
    });
    workerHistoryStore.add(currentLane, { role: "user", text: "current generation", ts: Date.now() });
    assert.equal(laneGenerationStore.bumpGeneration(resolveSyncNamespace("main"), logicalLane), 2);

    const resultPromise = waitForWsMessage(
      client,
      (msg) => msg.type === "result" && msg.kind === "clear_history" && msg.ok === true,
      1500,
    );
    client.send(JSON.stringify({ type: "clear_history" }));
    const result = await resultPromise;

    assert.equal(result.type, "result");
    assert.equal(laneGenerationStore.getGeneration(resolveSyncNamespace("main"), logicalLane), 3);
    assert.deepEqual(workerHistoryStore.get(currentLane), []);

    try {
      client.terminate();
    } catch {
      // ignore
    }
  });
});

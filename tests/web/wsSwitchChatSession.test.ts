import { describe, it, beforeEach, afterEach } from "node:test";
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
import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { DirectoryManager } from "../../server/telegram/utils/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { resolveSyncLaneKey, resolveSyncNamespace } from "../../server/web/server/sync/lane.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";

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

describe("web/server/ws: in-band switch_chat_session", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let workspaceRoot: string;
  let workerHistoryStore: HistoryStore;
  let plannerHistoryStore: HistoryStore;
  let syncEventStore: SyncEventStore;
  let workerFactory: ReturnType<typeof createFakeSessionFactory> | null = null;
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
    syncEventStore = new SyncEventStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);
    const nextWorkerFactory = createFakeSessionFactory("worker", { blockFirstSend: true });
    workerFactory = nextWorkerFactory;
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
        syncEventStore,
      },
      sessions: {
        workerSessionManager: new SessionManager(0, 0, "workspace-write", "test-model", undefined, undefined, {
          createSession: nextWorkerFactory.factory as never,
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
    workerFactory?.releaseFirstSend();
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    sockets.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("switches chatSessionId in-band without dropping the socket connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.main", "ads-chat.planner"]);
    sockets.push(ws);

    let isClosed = false;
    ws.on("close", () => {
      isClosed = true;
    });

    const welcomePromise = waitForWsMessage(ws, (m) => m.type === "welcome");
    await waitForWsOpen(ws);

    const initialWelcome = await welcomePromise;
    assert.equal(initialWelcome.chatSessionId, "planner");

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
      chatSessionId: "planner",
    });
    assert.ok(syncEventStore.getLatestSeqForLanes(resolveSyncNamespace("session-switched"), [switchedLaneKey]) > 0);
    assert.equal(syncEventStore.getLatestSeqForLanes(resolveSyncNamespace("planner"), [initialLaneKey]), 0);

    // Connection must have remained open
    assert.equal(isClosed, false);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it("persists prompts received during a switch in the new history lane", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.main", "ads-chat.session-initial"]);
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
    const initialHistory = workerHistoryStore.get(initialHistoryKey);
    const switchedHistory = workerHistoryStore.get(switchedHistoryKey);
    assert.equal(initialHistory.some((entry) => entry.text === "second prompt"), false);
    assert.ok(switchedHistory.some((entry) => entry.text === "second prompt"));
  });
});

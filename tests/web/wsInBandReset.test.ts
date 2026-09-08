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
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { resolveSyncLaneKey } from "../../server/web/server/sync/lane.js";
import { WebLaneGenerationStore } from "../../server/web/server/sync/laneGeneration.js";
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

function collectWsMessages(client: WebSocket): { messages: WsJson[]; stop: () => void } {
  const messages: WsJson[] = [];
  const handler = (raw: RawData) => {
    try {
      messages.push(JSON.parse(raw.toString("utf8")) as WsJson);
    } catch {
      // ignore
    }
  };
  client.on("message", handler);
  return {
    messages,
    stop: () => client.off("message", handler),
  };
}

function createFakeSessionFactory(prefix: string, options: { blockFirstSend?: boolean } = {}) {
  let nextId = 1;
  let firstSend = true;
  let resolveFirstSendStarted: (() => void) | null = null;
  let resolveFirstSendCompleted: (() => void) | null = null;
  let releaseFirstSend: (() => void) | null = null;
  const firstSendStarted = new Promise<void>((resolve) => {
    resolveFirstSendStarted = resolve;
  });
  const firstSendCompleted = new Promise<void>((resolve) => {
    resolveFirstSendCompleted = resolve;
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
          let isBlockedFirstSend = false;
          if (options.blockFirstSend && firstSend) {
            firstSend = false;
            isBlockedFirstSend = true;
            resolveFirstSendStarted?.();
            await firstSendGate;
          }
          const inputText = typeof input === "string" ? input : "";
          const response = inputText.includes("first prompt")
            ? "first response"
            : inputText.includes("second prompt")
              ? "second response"
              : "ok";
          if (isBlockedFirstSend) {
            resolveFirstSendCompleted?.();
          }
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
        getActiveAgentId: () => "codex",
        listAgents: () => [{ metadata: { id: "codex", name: "Codex" }, status: { ready: true, streaming: false } }],
        switchAgent: () => {},
      };

      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        initialWorkingDirectory: workingDirectory,
        initialModel: "test-model",
      });
      created.push({
        orchestrator,
        adapter,
        get resetCalls() {
          return resetCalls;
        },
        get threadId() {
          return threadId;
        },
      });
      return orchestrator;
    },
    firstSendStarted,
    firstSendCompleted,
    releaseFirstSend: () => releaseFirstSend?.(),
  };
}

describe("web/server/ws: in-band Planner session reset (Issue #158)", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let workspaceRoot: string;
  let workerHistoryStore: HistoryStore;
  let plannerHistoryStore: HistoryStore;
  let syncEventStore: SyncEventStore;
  let laneGenerationStore: WebLaneGenerationStore;
  let workerFactory: ReturnType<typeof createFakeSessionFactory> | null = null;
  let plannerFactory: ReturnType<typeof createFakeSessionFactory> | null = null;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ws-inband-reset-test-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-ws-inband-reset-ws-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests(process.env.ADS_STATE_DB_PATH);

    server = http.createServer();
    const clients = new Set<import("ws").WebSocket>();
    const clientMetaByWs = new Map<import("ws").WebSocket, any>();
    workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    syncEventStore = new SyncEventStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    laneGenerationStore = new WebLaneGenerationStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);
    workerFactory = createFakeSessionFactory("worker");
    plannerFactory = createFakeSessionFactory("planner", { blockFirstSend: true });

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
        runAdsCommandLine: async () => ({ ok: true, output: "" }),
        sanitizeInput: (payload) => String(payload ?? ""),
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
    plannerFactory?.releaseFirstSend();
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

  it("keeps the same Planner WebSocket OPEN across clear_history reset and delivers advanced generation baseline", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.test-session", "ads-chat.planner"]);
    sockets.push(ws);

    let closed = false;
    ws.on("close", () => {
      closed = true;
    });

    const initialWelcomePromise = waitForWsMessage(ws, (m) => m.type === "welcome");
    await waitForWsOpen(ws);
    const initialWelcome = await initialWelcomePromise;
    assert.equal(initialWelcome.type, "welcome");
    assert.equal(initialWelcome.chatSessionId, "planner");
    const initialGeneration = Number(initialWelcome.laneGeneration ?? 1);

    // Seed history in planner lane
    const initialHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "planner",
      generation: initialGeneration,
    });
    plannerHistoryStore.add(initialHistoryKey, {
      role: "user",
      text: "planner prompt to be cleared",
      ts: Date.now(),
    });

    // Send reset
    const resetPromise = waitForWsMessage(
      ws,
      (m) => m.type === "session_reset" && m.source === "clear_history" && m.sourceChatSessionId === "planner",
    );
    const resultPromise = waitForWsMessage(
      ws,
      (m) => m.type === "result" && m.kind === "clear_history" && m.ok === true,
    );
    const newWelcomePromise = waitForWsMessage(
      ws,
      (m) => m.type === "welcome" && m.chatSessionId === "planner" && Number(m.laneGeneration) > initialGeneration,
    );

    ws.send(JSON.stringify({ type: "clear_history" }));

    const resetMsg = await resetPromise;
    assert.equal(resetMsg.type, "session_reset");
    assert.equal(resetMsg.scope, "lane");
    const nextGeneration = Number(resetMsg.laneGeneration);
    assert.ok(nextGeneration > initialGeneration, `next generation ${nextGeneration} should be > ${initialGeneration}`);

    const resultMsg = await resultPromise;
    assert.equal(resultMsg.ok, true);

    const newWelcome = await newWelcomePromise;
    assert.equal(newWelcome.type, "welcome");
    assert.equal(newWelcome.chatSessionId, "planner");
    assert.equal(Number(newWelcome.laneGeneration), nextGeneration);
    assert.equal(newWelcome.contextMode, "fresh");

    plannerFactory!.releaseFirstSend();

    // Socket must remain open
    assert.equal(closed, false);
    assert.equal(ws.readyState, WebSocket.OPEN);

    // Old history cleared and new history lane empty
    const oldEntries = plannerHistoryStore.get(initialHistoryKey);
    assert.equal(oldEntries.length, 0);

    // Subsequent prompt on the same socket executes on the new generation
    const ackPromise = waitForWsMessage(ws, (m) => m.type === "ack" && m.client_message_id === "after-reset");
    const promptResultPromise = waitForWsMessage(ws, (m) => m.type === "result" && m.output === "ok");
    ws.send(JSON.stringify({ type: "prompt", payload: "hello after reset", client_message_id: "after-reset" }));
    await ackPromise;
    await promptResultPromise;

    const newHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "planner",
      generation: nextGeneration,
    });
    const newHistory = plannerHistoryStore.get(newHistoryKey);
    assert.ok(newHistory.some((entry) => entry.text === "hello after reset"));
  });

  it("does not execute a prompt on the old generation arriving during the reset barrier", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.test-session", "ads-chat.planner"]);
    sockets.push(ws);

    const initialWelcomePromise = waitForWsMessage(ws, (m) => m.type === "welcome");
    await waitForWsOpen(ws);
    const initialWelcome = await initialWelcomePromise;
    const initialGeneration = Number(initialWelcome.laneGeneration ?? 1);

    // Start a long-running prompt on the initial generation to create a barrier
    const firstAckPromise = waitForWsMessage(ws, (m) => m.type === "ack" && m.client_message_id === "first");
    ws.send(JSON.stringify({ type: "prompt", payload: "first prompt", client_message_id: "first" }));
    await firstAckPromise;
    await plannerFactory!.firstSendStarted;

    // Send clear_history followed immediately by a prompt sent before reset completes
    const resetPromise = waitForWsMessage(ws, (m) => m.type === "session_reset");
    const newWelcomePromise = waitForWsMessage(
      ws,
      (m) => m.type === "welcome" && Number(m.laneGeneration) > initialGeneration,
    );

    ws.send(JSON.stringify({ type: "clear_history" }));
    // Prompt arriving during reset barrier
    ws.send(JSON.stringify({ type: "prompt", payload: "prompt during reset barrier", client_message_id: "barrier-msg" }));

    // Unblock the first prompt
    plannerFactory!.releaseFirstSend();

    await resetPromise;
    const newWelcome = await newWelcomePromise;
    const nextGeneration = Number(newWelcome.laneGeneration);
    assert.ok(nextGeneration > initialGeneration);

    // Verify the prompt arriving during reset was not executed against the old generation
    const oldHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "planner",
      generation: initialGeneration,
    });
    const oldHistory = plannerHistoryStore.get(oldHistoryKey);
    assert.equal(
      oldHistory.some((e) => e.text === "prompt during reset barrier"),
      false,
      "Prompt sent during reset barrier must not persist or run on the old generation",
    );

    // Socket still open
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it("rebinds multiple live connections for the affected lane consistently", async () => {
    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.planner"];
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols);
    sockets.push(ws1, ws2);

    let ws1Closed = false;
    let ws2Closed = false;
    ws1.on("close", () => {
      ws1Closed = true;
    });
    ws2.on("close", () => {
      ws2Closed = true;
    });

    const ws1WelcomePromise = waitForWsMessage(ws1, (m) => m.type === "welcome");
    const ws2WelcomePromise = waitForWsMessage(ws2, (m) => m.type === "welcome");
    await waitForWsOpen(ws1);
    await waitForWsOpen(ws2);

    const initialWelcome1 = await ws1WelcomePromise;
    const initialWelcome2 = await ws2WelcomePromise;
    assert.equal(initialWelcome1.chatSessionId, "planner");
    assert.equal(initialWelcome2.chatSessionId, "planner");
    const gen1 = Number(initialWelcome1.laneGeneration ?? 1);

    // Reset from ws1
    const ws1ResetPromise = waitForWsMessage(ws1, (m) => m.type === "session_reset");
    const ws2ResetPromise = waitForWsMessage(ws2, (m) => m.type === "session_reset");
    const ws1NewWelcomePromise = waitForWsMessage(ws1, (m) => m.type === "welcome" && Number(m.laneGeneration) > gen1);
    const ws2NewWelcomePromise = waitForWsMessage(ws2, (m) => m.type === "welcome" && Number(m.laneGeneration) > gen1);

    ws1.send(JSON.stringify({ type: "clear_history" }));

    const [reset1, reset2] = await Promise.all([ws1ResetPromise, ws2ResetPromise]);
    assert.equal(reset1.type, "session_reset");
    assert.equal(reset2.type, "session_reset");
    assert.equal(reset1.laneGeneration, reset2.laneGeneration);

    const [welcome1, welcome2] = await Promise.all([ws1NewWelcomePromise, ws2NewWelcomePromise]);
    assert.equal(welcome1.laneGeneration, reset1.laneGeneration);
    assert.equal(welcome2.laneGeneration, reset2.laneGeneration);

    // Both sockets must remain OPEN
    assert.equal(ws1Closed, false);
    assert.equal(ws2Closed, false);
    assert.equal(ws1.readyState, WebSocket.OPEN);
    assert.equal(ws2.readyState, WebSocket.OPEN);

    const nextGeneration = Number(reset1.laneGeneration);
    const newHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "planner",
      generation: nextGeneration,
    });

    // A prompt from ws2 should be received and broadcast on the new generation
    plannerFactory!.releaseFirstSend();
    const ws2ResultPromise = waitForWsMessage(ws2, (m) => m.type === "result" && m.output === "ok");
    ws2.send(JSON.stringify({ type: "prompt", payload: "from ws2 on new generation", client_message_id: "ws2-msg" }));
    await ws2ResultPromise;
    const newHistory = plannerHistoryStore.get(newHistoryKey);
    assert.ok(newHistory.some((e) => e.text === "from ws2 on new generation"));
  });

  it("does not let an in-flight sibling prompt restore the old lane binding", async () => {
    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.planner"];
    const resetClient = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols);
    const activeClient = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols);
    sockets.push(resetClient, activeClient);

    const resetWelcomePromise = waitForWsMessage(resetClient, (m) => m.type === "welcome");
    const activeWelcomePromise = waitForWsMessage(activeClient, (m) => m.type === "welcome");
    await waitForWsOpen(resetClient);
    await waitForWsOpen(activeClient);
    const resetWelcome = await resetWelcomePromise;
    await activeWelcomePromise;
    const initialGeneration = Number(resetWelcome.laneGeneration ?? 1);

    const activeAckPromise = waitForWsMessage(activeClient, (m) => m.type === "ack" && m.client_message_id === "active");
    activeClient.send(JSON.stringify({ type: "prompt", payload: "first prompt", client_message_id: "active" }));
    await activeAckPromise;
    await plannerFactory!.firstSendStarted;

    const resetWelcomeAfterPromise = waitForWsMessage(
      resetClient,
      (m) => m.type === "welcome" && Number(m.laneGeneration) > initialGeneration,
    );
    resetClient.send(JSON.stringify({ type: "clear_history" }));
    const resetWelcomeAfter = await resetWelcomeAfterPromise;
    const nextGeneration = Number(resetWelcomeAfter.laneGeneration);

    plannerFactory!.releaseFirstSend();
    await plannerFactory!.firstSendCompleted;

    const nextHistoryKey = resolveSyncLaneKey({
      authUserId: "test",
      sessionId: "test-session",
      chatSessionId: "planner",
      generation: nextGeneration,
    });
    const nextPromptResultPromise = waitForWsMessage(
      activeClient,
      (m) => m.type === "result" && m.output === "second response",
    );
    activeClient.send(JSON.stringify({ type: "prompt", payload: "second prompt", client_message_id: "active-next" }));
    await nextPromptResultPromise;

    assert.equal(activeClient.readyState, WebSocket.OPEN);
    assert.ok(plannerHistoryStore.get(nextHistoryKey).some((entry) => entry.text === "second prompt"));
  });

  it("leaves unrelated worker lanes isolated and undisturbed during a Planner reset", async () => {
    const plannerWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.test-session", "ads-chat.planner"]);
    const workerWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ads-v1", "ads-session.test-session", "ads-chat.main"]);
    sockets.push(plannerWs, workerWs);

    const plannerWelcome = waitForWsMessage(plannerWs, (m) => m.type === "welcome");
    const workerWelcome = waitForWsMessage(workerWs, (m) => m.type === "welcome");
    await waitForWsOpen(plannerWs);
    await waitForWsOpen(workerWs);
    await plannerWelcome;
    await workerWelcome;

    const workerListener = collectWsMessages(workerWs);

    const plannerResetPromise = waitForWsMessage(plannerWs, (m) => m.type === "session_reset");
    plannerWs.send(JSON.stringify({ type: "clear_history" }));
    await plannerResetPromise;

    // Small tick to ensure no leak to worker
    await new Promise((resolve) => setTimeout(resolve, 100));
    workerListener.stop();

    assert.equal(
      workerListener.messages.some((m) => m.type === "session_reset"),
      false,
      "Worker connection must not receive planner session_reset",
    );
    assert.equal(workerWs.readyState, WebSocket.OPEN);
  });
});

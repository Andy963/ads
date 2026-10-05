import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { upsertWebProject, updateWebProject, getWebProjectRecord } from "../../server/web/projects/store.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { resolveSyncLaneKey, resolveSyncNamespace } from "../../server/web/server/sync/lane.js";
import { WebLaneGenerationStore } from "../../server/web/server/sync/laneGeneration.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import type { AgentEvent } from "../../server/codex/events.js";

type WsJson = { type?: unknown; [k: string]: unknown };

type FakeSession = {
  resetCalls: number;
  threadId: string | null;
  workingDirectory?: string;
  send: () => Promise<{ response: string }>;
  invokeAgent: () => Promise<{ response: string; agentId: string; usage: null }>;
  onEvent: (handler: (event: AgentEvent) => void) => () => void;
  emitEvent: (event: AgentEvent) => void;
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
      const eventHandlers = new Set<(event: AgentEvent) => void>();
      const session: FakeSession = {
        resetCalls: 0,
        threadId: `${prefix}-thread-${nextId++}`,
        workingDirectory: cwd,
        send: async () => ({ response: "ok" }),
        invokeAgent: async () => ({ ...await session.send(), agentId: "codex", usage: null }),
        onEvent: (handler) => {
          eventHandlers.add(handler);
          return () => { eventHandlers.delete(handler); };
        },
        emitEvent: (event) => {
          for (const handler of eventHandlers) handler(event);
        },
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

function waitForWsMessage(client: WebSocket, predicate: (msg: WsJson) => boolean, timeoutMs = 1500, label = ""): Promise<WsJson> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ws message${label ? `: ${label}` : ""}`)), timeoutMs);
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
  let advisorSessions: FakeSession[];
  let workerHistoryStore: HistoryStore;
  let advisorHistoryStore: HistoryStore;
  let syncEventStore: SyncEventStore;
  let laneGenerationStore: WebLaneGenerationStore;
  let workspaceLock: AsyncLock;
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
    advisorHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-advisor" });
    syncEventStore = new SyncEventStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    laneGenerationStore = new WebLaneGenerationStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    const lock = new AsyncLock();
    workspaceLock = lock;
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);
    const workerFactory = createFakeSessionFactory("worker");
    const advisorFactory = createFakeSessionFactory("advisor");
    workerSessions = workerFactory.created;
    advisorSessions = advisorFactory.created;

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
        authenticateRequest: (req) => ({ ok: true, userId: String(req.headers["x-test-user"] ?? "test"), connector: req.headers["x-test-connector"] === "true" }),
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
        advisorSessionManager: new SessionManager(0, 0, "read-only", "test-model", undefined, undefined, {
          createSession: advisorFactory.factory as never,
        }),
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
        runAdsCommandLine: async (command) => await runAdsCommandLineImpl(command),
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

  function registerProject(userId = "test", projectId = "shared-project", chatSessionId = "main") {
    const db = getStateDatabase();
    db.prepare("INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, 'fixture', 1, 1)").run(userId, userId);
    return upsertWebProject(db, { userId, projectId, chatSessionId, workspaceRoot, name: "Shared project" });
  }

  function connectProject(projectId = "shared-project", chatSessionId = "main", userId = "test", query = "", connector = false) {
    const frames: WsJson[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}/${query}`, ["ads-v1", `ads-session.${projectId}`, `ads-chat.${chatSessionId}`], {
      origin: "http://localhost", headers: { "x-test-user": userId, "x-test-connector": String(connector) },
    });
    client.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as WsJson));
    const ready = waitForWsMessage(client, (frame) => frame.type === "welcome");
    return { client, frames, ready };
  }

  it("synchronizes bidirectional user/reply fanout, session selection and stale reconnects", async () => {
    registerProject();
    const a = connectProject();
    const b = connectProject();
    let reconnect: ReturnType<typeof connectProject> | undefined;
    try {
      await Promise.all([a.ready, b.ready]);
      const sendTurn = async (sender: WebSocket, id: string, chatSessionId = "main") => {
        const users = [a, b].map(({ client }) => waitForWsMessage(client, (f) => f.type === "user" && f.clientMessageId === id));
        const replies = [a, b].map(({ client }) => waitForWsMessage(client, (f) => f.type === "result" && f.clientMessageId === id));
        sender.send(JSON.stringify({ type: "prompt", payload: id, client_message_id: id, chat_session_id: chatSessionId }));
        await Promise.all([...users, ...replies]);
        for (const peer of [a, b]) {
          assert.equal(peer.frames.filter((f) => f.type === "user" && f.clientMessageId === id).length, 1);
          assert.equal(peer.frames.filter((f) => f.type === "result" && f.clientMessageId === id).length, 1);
        }
      };
      await sendTurn(a.client, "from-ios");
      await sendTurn(b.client, "from-desktop");
      const welcomes = [a, b].map(({ client }) => waitForWsMessage(client, (f) => f.type === "welcome" && f.chatSessionId === "new-chat"));
      a.client.send(JSON.stringify({ type: "switch_chat_session", payload: { chatSessionId: "new-chat" } }));
      // Source input queued immediately after switching must bind to the new lane.
      await sendTurn(a.client, "immediate-new-chat-input", "new-chat");
      await Promise.all(welcomes);
      assert.equal(getWebProjectRecord(getStateDatabase(), "test", "shared-project")?.chatSessionId, "new-chat");
      await sendTurn(b.client, "from-desktop-new-chat", "new-chat");
      const staleError = waitForWsMessage(b.client, (f) => f.type === "error" && f.code === "session_changed");
      b.client.send(JSON.stringify({ type: "prompt", payload: "late-stale-input", client_message_id: "late-stale-input", chat_session_id: "main" }));
      await staleError;
      const oldKey = resolveSyncLaneKey({ authUserId: "test", sessionId: "shared-project", chatSessionId: "main" });
      const newKey = resolveSyncLaneKey({ authUserId: "test", sessionId: "shared-project", chatSessionId: "new-chat" });
      assert.equal(workerHistoryStore.get(oldKey).some((e) => e.text === "immediate-new-chat-input"), false);
      assert.equal(workerHistoryStore.get(newKey).filter((e) => e.text === "immediate-new-chat-input").length, 1);
      assert.equal(workerHistoryStore.get(newKey).some((e) => e.text === "late-stale-input"), false);
      const duplicateAck = waitForWsMessage(b.client, (f) => f.type === "ack" && f.client_message_id === "from-desktop-new-chat");
      b.client.send(JSON.stringify({ type: "prompt", payload: "from-desktop-new-chat", client_message_id: "from-desktop-new-chat" }));
      assert.equal((await duplicateAck).duplicate, true);
      reconnect = connectProject("shared-project", "main", "test", "?afterSeq=1&laneGeneration=1");
      const replay = waitForWsMessage(reconnect.client, (f) => f.type === "history");
      const welcome = await reconnect.ready;
      assert.equal(welcome.chatSessionId, "new-chat");
      assert.equal(welcome.historyMode, "snapshot");
      assert.match(JSON.stringify(await replay), /from-desktop-new-chat/);
    } finally {
      a.client.terminate(); b.client.terminate(); reconnect?.client.terminate();
    }
  });

  it("propagates project-store selection changes in order without crossing user/project/Acopilot boundaries", async () => {
    registerProject();
    registerProject("other-user");
    const peers = [connectProject(), connectProject(), connectProject("shared-project", "acopilot"),
      connectProject("other-project"), connectProject("shared-project", "main", "other-user"),
      connectProject("shared-project", "connector-chat", "test", "", true)];
    try {
      const initial = await Promise.all(peers.map((peer) => peer.ready));
      assert.equal(initial[5]?.chatSessionId, "connector-chat");
      const switched = peers.slice(0, 2).map(({ client }) => waitForWsMessage(client, (f) => f.type === "welcome" && f.chatSessionId === "latest"));
      updateWebProject(getStateDatabase(), { userId: "test", projectId: "shared-project", chatSessionId: "superseded" });
      updateWebProject(getStateDatabase(), { userId: "test", projectId: "shared-project", chatSessionId: "latest" });
      await Promise.all(switched);
      for (const peer of peers.slice(0, 2)) {
        assert.equal(peer.frames.some((f) => f.type === "welcome" && f.chatSessionId === "superseded"), false);
      }
      for (const peer of peers.slice(2)) {
        assert.equal(peer.frames.filter((f) => f.type === "welcome").length, 1);
      }
      assert.equal(getWebProjectRecord(getStateDatabase(), "other-user", "shared-project")?.chatSessionId, "main");
    } finally { for (const peer of peers) peer.client.terminate(); }
  });

  it("fences peer input during a queued rebind and bootstraps messages emitted before that peer catches up", async () => {
    registerProject();
    const a = connectProject();
    const b = connectProject();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const heldLock = workspaceLock.runExclusive(async () => { started.resolve(); await release.promise; });
    try {
      await Promise.all([a.ready, b.ready]);
      await started.promise;
      const commandAck = waitForWsMessage(b.client, (f) => f.type === "ack" && f.client_message_id === "old-command");
      b.client.send(JSON.stringify({ type: "command", payload: "hold", client_message_id: "old-command" }));
      await commandAck;
      const switchedA = waitForWsMessage(a.client, (f) => f.type === "welcome" && f.chatSessionId === "while-busy", 4000, "switch busy");
      const switchedB = waitForWsMessage(b.client, (f) => f.type === "welcome" && f.chatSessionId === "while-busy", 4000, "switch busy");
      a.client.send(JSON.stringify({ type: "switch_chat_session", payload: { chatSessionId: "while-busy" } }));
      await switchedA;
      const rejected = waitForWsMessage(b.client, (f) => f.type === "error" && f.code === "session_changed", 4000, "reject old input");
      b.client.send(JSON.stringify({ type: "prompt", payload: "stale-input", client_message_id: "stale-input" }));
      await rejected;
      // Persist a new-lane message while the other peer is still finishing old work.
      const persisted = waitForWsMessage(a.client, (f) => f.type === "user" && f.clientMessageId === "new-while-busy", 4000, "persist new input");
      a.client.send(JSON.stringify({ type: "prompt", payload: "new-while-busy", client_message_id: "new-while-busy" }));
      await persisted;
      const replay = waitForWsMessage(b.client, (f) => f.type === "history", 4000, "busy history");
      const completed = waitForWsMessage(a.client, (f) => f.type === "result" && f.clientMessageId === "new-while-busy");
      release.resolve();
      await switchedB;
      assert.match(JSON.stringify(await replay), /new-while-busy/);
      await completed;
      const key = resolveSyncLaneKey({ authUserId: "test", sessionId: "shared-project", chatSessionId: "while-busy" });
      assert.equal(workerHistoryStore.get(key).some((e) => e.text === "stale-input"), false);
      const welcomeIndex = b.frames.findIndex((f) => f.type === "welcome" && f.chatSessionId === "while-busy", 4000, "switch busy");
      assert.equal(b.frames.slice(welcomeIndex).some((f) => f.type === "result" && f.clientMessageId === "old-command"), false);
    } finally {
      release.resolve();
      await heldLock;
      a.client.terminate(); b.client.terminate();
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

    const resultPromise = waitForWsMessage(clientB, (msg) => msg.type === "result" && msg.kind === "execute");
    const workspacePromise = waitForWsMessage(clientB, (msg) => msg.type === "workspace");
    resolveRun?.({ ok: true, output: "done" });

    const result = await resultPromise;
    const workspace = await workspacePromise;
    assert.equal(result.type, "result");
    assert.equal(result.command, "echo hello");
    assert.equal(Object.hasOwn(result, "output"), false);
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

  for (const chatSessionId of ["main", "advisor"]) {
    it(`sends metadata-only live and reconnect command frames in ${chatSessionId}`, { timeout: 10_000 }, async () => {
      const protocols = ["ads-v1", "ads-session.command-stream", `ads-chat.${chatSessionId}`];
      const url = `ws://127.0.0.1:${port}`;
      const received: WsJson[] = [];
      const client = new WebSocket(url, protocols, { origin: "http://localhost" });
      client.on("message", (raw) => received.push(JSON.parse(raw.toString()) as WsJson));
      let reconnected: WebSocket | undefined;
      const finishTurn = Promise.withResolvers<void>();
      try {
        await waitForWsOpen(client);
        const session = (chatSessionId === "advisor" ? advisorSessions : workerSessions).at(-1);
        assert.ok(session);
        const emitCommand = (type: "item.started" | "item.updated" | "item.completed", status: string) => {
          session.emitEvent({
            phase: "command",
            title: "command",
            timestamp: Date.now(),
            raw: {
              type,
              item: {
                type: "command_execution", id: "cmd-1", command: "npm test", status,
                aggregated_output: "private provider command output",
                ...(status === "completed" ? { exit_code: 0 } : {}),
              },
            },
          });
        };
        session.send = async () => {
          emitCommand("item.started", "inProgress");
          emitCommand("item.updated", "inProgress");
          await finishTurn.promise;
          emitCommand("item.completed", "completed");
          return { response: "Assistant summary" };
        };
        const startedPromise = waitForWsMessage(client, (frame) => frame.type === "command", 4000, "command start");
        client.send(JSON.stringify({ type: "prompt", payload: "Run checks", client_message_id: "command-stream-prompt" }));
        const started = await startedPromise;
        assert.equal((started.command as Record<string, unknown>).command, "npm test");
        assert.equal(started.clientMessageId, "command-stream-prompt");
        const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
        client.terminate();
        await closed;

        reconnected = new WebSocket(url, protocols, { origin: "http://localhost" });
        reconnected.on("message", (raw) => received.push(JSON.parse(raw.toString()) as WsJson));
        const snapshotPromise = waitForWsMessage(reconnected, (frame) => frame.type === "command_snapshot", 4000, "reconnect snapshot");
        await waitForWsOpen(reconnected);
        const snapshot = await snapshotPromise;
        assert.equal(snapshot.bootstrap, true);
        assert.equal((snapshot.command as Record<string, unknown>).identity, (started.command as Record<string, unknown>).identity);
        assert.equal((snapshot.command as Record<string, unknown>).command, "npm test");

        const completedPromise = waitForWsMessage(reconnected, (frame) => frame.type === "command", 4000, "command completion");
        const resultPromise = waitForWsMessage(reconnected, (frame) => frame.type === "result", 4000, "assistant result");
        finishTurn.resolve();
        const completed = await completedPromise;
        assert.equal((completed.command as Record<string, unknown>).status, "completed");
        assert.equal((await resultPromise).output, "Assistant summary");
        assert.equal(received.filter((frame) => frame.type === "command").length, 2);
        assert.doesNotMatch(JSON.stringify(received), /private provider command output|outputDelta|aggregated_output/);
        for (const frame of received.filter((entry) => entry.type === "command" || entry.type === "command_snapshot")) {
          assert.equal(Object.hasOwn(frame.command as Record<string, unknown>, "output"), false);
        }
      } finally {
        finishTurn.resolve();
        client.terminate();
        reconnected?.terminate();
      }
    });
  }

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
    assert.equal(advisorSessions.length, 0);
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

  it("does not allow the advisor lane to reset any worker lane", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const mainProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const advisorProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.acopilot"];

    const mainClient = new WebSocket(url, mainProtocols, { origin: "http://localhost" });
    const advisorClient = new WebSocket(url, advisorProtocols, { origin: "http://localhost" });
    await waitForWsOpen(mainClient);
    await waitForWsOpen(advisorClient);

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
      advisorClient,
      (msg) => msg.type === "session_reset" && msg.sourceChatSessionId === "acopilot" && msg.scope === "lane",
      1500,
    );
    const resultPromise = waitForWsMessage(
      advisorClient,
      (msg) => msg.type === "result" && msg.kind === "clear_history" && msg.ok === true,
      1500,
    );

    advisorClient.send(JSON.stringify({ type: "clear_history", payload: { scope: "shared" } }));

    const reset = await resetPromise;
    const result = await resultPromise;
    assert.equal(reset.type, "session_reset");
    assert.equal(result.type, "result");
    assert.equal(workerSessions[0]?.resetCalls, 0);
    assert.equal(advisorSessions[0]?.resetCalls, 1);
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
      advisorClient.terminate();
    } catch {
      // ignore
    }
  });

  it("resets disconnected worker lanes while keeping the advisor lane isolated", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const mainProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];
    const advisorProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.acopilot"];
    const customWorkerProtocols = ["ads-v1", "ads-session.test-session", "ads-chat.worker-custom"];

    const mainClient = new WebSocket(url, mainProtocols, { origin: "http://localhost" });
    const advisorClient = new WebSocket(url, advisorProtocols, { origin: "http://localhost" });
    const customWorkerClient = new WebSocket(url, customWorkerProtocols, { origin: "http://localhost" });
    await waitForWsOpen(mainClient);
    await waitForWsOpen(advisorClient);
    await waitForWsOpen(customWorkerClient);

    workerHistoryStore.add(
      resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "main", generation: 1 }),
      { role: "user", text: "main stale", ts: Date.now() },
    );
    advisorHistoryStore.add(
      resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "acopilot", generation: 1 }),
      { role: "user", text: "advisor stale", ts: Date.now() },
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
    assert.equal(advisorSessions[0]?.resetCalls, 0);
    assert.deepEqual(
      workerHistoryStore.get(
        resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "main", generation: 1 }),
      ),
      [],
    );
    assert.equal(advisorSessions[0]?.threadId === null, false);
    assert.equal(
      advisorHistoryStore.get(
        resolveSyncLaneKey({ authUserId: "test", sessionId: "test-session", chatSessionId: "acopilot", generation: 1 }),
      )[0]?.text,
      "advisor stale",
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
      advisorClient.terminate();
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

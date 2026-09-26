import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { type RawData } from "ws";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import { resolveSyncNamespace } from "../../server/web/server/sync/lane.js";
import { createPromptQueueStore } from "../../server/state/promptQueueStore.js";

type WsJson = { type?: unknown; [k: string]: unknown };

function waitForWsOpen(client: WebSocket, timeoutMs = 3000): Promise<void> {
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

function waitForWsMessage(client: WebSocket, predicate: (msg: WsJson) => boolean, timeoutMs = 3000): Promise<WsJson> {
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

describe("web/server/ws/preflight-persistence", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  let historyStore: HistoryStore;
  let syncEventStore: SyncEventStore;
  let promptQueueStore: ReturnType<typeof createPromptQueueStore>;
  let lock: AsyncLock;
  let unblockCommands: (() => void) | null;
  let failAgentRequests: boolean;
  /** Held by tests that need a prompt to occupy the lane while another waits. */
  let holdAgentRequests: Promise<void> | null;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-preflight-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    process.env.CODEX_HOME = path.join(tmpDir, "codex");
    delete process.env.CFMEM_URL;
    delete process.env.CFMEM_API_KEY;
    resetStateDatabaseForTests();

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
    failAgentRequests = false;
    holdAgentRequests = null;
    const createSession = ({ cwd }: { cwd: string }): HybridOrchestrator => new HybridOrchestrator({
      initialWorkingDirectory: cwd,
      adapters: [{
        id: "codex",
        metadata: { id: "codex", name: "Preflight fixture", capabilities: ["text"] },
        send: async () => {
          if (holdAgentRequests) await holdAgentRequests;
          if (failAgentRequests) throw new Error("fixture agent failure");
          return { response: "Fixture reply", usage: null, agentId: "codex" };
        },
        status: () => ({ ready: true, streaming: false }),
        onEvent: () => () => {},
        reset: () => {},
      }],
    });
    const workerSessionManager = new SessionManager(0, 0, "workspace-write", "test-model", undefined, undefined, { createSession });
    const advisorSessionManager = new SessionManager(0, 0, "read-only", "test-model", undefined, undefined, { createSession });
    const workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    const advisorHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-advisor" });
    historyStore = workerHistoryStore;
    syncEventStore = new SyncEventStore({ stateDbPath: process.env.ADS_STATE_DB_PATH });
    promptQueueStore = createPromptQueueStore(getStateDatabase(process.env.ADS_STATE_DB_PATH));
    lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);

    unblockCommands = null;
    const blocked = new Promise<void>((resolve) => {
      unblockCommands = resolve;
    });
    const runAdsCommandLine = async (): Promise<{ ok: boolean; output: string }> => {
      await blocked;
      return { ok: true, output: "" };
    };

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
        syncEventStore,
        promptQueueStore,
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
        runAdsCommandLine,
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
    // The next message has not necessarily entered the workspace lock yet.
    // Wait for every accepted turn, not just the currently held command.
    unblockCommands?.();
    const historyKey = "test::test::main";
    const expectedTurns = historyStore.get(historyKey).filter((entry) => entry.role === "user").length;
    const deadline = Date.now() + 3000;
    while (true) {
      const completedTurns = historyStore.get(historyKey).filter((entry) =>
        entry.role === "ai" || (entry.role === "status" && ["execute", "error"].includes(entry.kind ?? "")),
      ).length;
      if (completedTurns >= expectedTurns && !lock.isBusy()) break;
      assert.ok(Date.now() < deadline, "Queued fixture turns must finish before database teardown");
      await delay(5);
    }
    await wss.stopPromptQueue();
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

  it("acks and persists a queued command even if an earlier command is still running", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });

    try {
      await waitForWsOpen(client);

      client.send(JSON.stringify({ type: "command", payload: "echo slow", client_message_id: "slow-blocker" }));
      client.send(JSON.stringify({ type: "command", payload: "echo queued", client_message_id: "m2" }));

      const ack = await waitForWsMessage(
        client,
        (msg) => msg.type === "ack" && msg.client_message_id === "m2",
        2000,
      );
      assert.equal(ack.type, "ack");

      try {
        client.terminate();
      } catch {
        // ignore
      }

      const historyKey = "test::test::main";
      const entries = historyStore.get(historyKey);
      const matched = entries.filter((entry) => entry.kind === "client_message_id:m2");
      assert.equal(matched.length, 1);
      assert.equal(matched[0]?.role, "user");
      assert.equal(matched[0]?.text, "echo queued");
    } finally {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
  });

  it("assigns an id and persists a prompt before queued execution when the client omits an id", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });

    try {
      await waitForWsOpen(client);
      client.send(JSON.stringify({ type: "command", payload: "echo slow", client_message_id: "slow-blocker" }));
      client.send(JSON.stringify({ type: "prompt", payload: "queued prompt" }));

      const ack = await waitForWsMessage(
        client,
        (msg) =>
          msg.type === "ack" &&
          typeof msg.client_message_id === "string" &&
          msg.client_message_id.startsWith("server-"),
        2000,
      );
      const clientMessageId = String(ack.client_message_id);
      const entries = historyStore.get("test::test::main");
      const matched = entries.filter((entry) => String(entry.kind ?? "").startsWith(`client_message_id:${clientMessageId}`));

      assert.equal(ack.duplicate, false);
      assert.equal(ack.queue_status, "queued");
      assert.equal(matched.length, 1);
      assert.equal(matched[0]?.role, "user");
      assert.equal(matched[0]?.text, "queued prompt");
    } finally {
      client.terminate();
    }
  });

  it("persists a prompt queue row before ack and deduplicates retries by client id", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });
    let releasePrompt: (() => void) | null = null;

    try {
      await waitForWsOpen(client);
      holdAgentRequests = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      client.send(JSON.stringify({ type: "command", payload: "echo slow", client_message_id: "slow-blocker" }));
      client.send(JSON.stringify({ type: "prompt", payload: "durable prompt", client_message_id: "durable-1" }));

      const firstAck = await waitForWsMessage(
        client,
        (msg) => msg.type === "ack" && msg.client_message_id === "durable-1" && msg.duplicate === false,
        2000,
      );
      assert.equal(firstAck.queue_status, "queued");
      assert.equal(promptQueueStore.getByClientMessageId("durable-1") !== null, true);
      const runningDeadline = Date.now() + 2000;
      while (promptQueueStore.getByClientMessageId("durable-1")?.status !== "running") {
        assert.ok(Date.now() < runningDeadline, "durable prompt should be visible while running");
        await delay(5);
      }
      const promptLifecycle = syncEventStore.readAfter({
        namespace: resolveSyncNamespace("main"),
        laneKey: "test::test::main",
      }).events.find((event) =>
        event.type === "prompt_queue"
        && (event.payload.entry as Record<string, unknown>)?.clientMessageId === "durable-1",
      );
      assert.equal((promptLifecycle?.payload.entry as Record<string, unknown>)?.text, "durable prompt");
      releasePrompt?.();
      releasePrompt = null;
      holdAgentRequests = null;

      client.send(JSON.stringify({ type: "prompt", payload: "durable prompt", client_message_id: "durable-1" }));
      const duplicateAck = await waitForWsMessage(
        client,
        (msg) => msg.type === "ack" && msg.client_message_id === "durable-1" && msg.duplicate === true,
        2000,
      );
      assert.equal(duplicateAck.queue_status !== undefined, true);
      assert.equal(promptQueueStore.getByClientMessageId("durable-1")?.clientMessageId, "durable-1");
      const history = historyStore.get("test::test::main").filter(
        (entry) => String(entry.kind ?? "").startsWith("client_message_id:durable-1"),
      );
      assert.equal(history.length, 1);
    } finally {
      releasePrompt?.();
      holdAgentRequests = null;
      client.terminate();
    }
  });

  it("requeues an explicit retry for a failed prompt and persists lifecycle transitions", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });

    try {
      await waitForWsOpen(client);
      failAgentRequests = true;
      client.send(JSON.stringify({
        type: "prompt",
        payload: { text: "retry me" },
        client_message_id: "retry-1",
      }));
      await waitForWsMessage(
        client,
        (msg) => msg.type === "ack" && msg.client_message_id === "retry-1",
        2000,
      );
      const failedDeadline = Date.now() + 3000;
      while (promptQueueStore.getByClientMessageId("retry-1")?.status !== "failed") {
        assert.ok(Date.now() < failedDeadline, "failed prompt should reach durable failed state");
        await delay(5);
      }

      failAgentRequests = false;
      client.send(JSON.stringify({
        type: "prompt",
        payload: { text: "retry me", replay_incomplete: true },
        client_message_id: "retry-1",
      }));
      const retryAck = await waitForWsMessage(
        client,
        (msg) => msg.type === "ack" && msg.client_message_id === "retry-1" && msg.duplicate === false,
        2000,
      );
      assert.equal(retryAck.queue_status, "queued");
      const completedDeadline = Date.now() + 3000;
      while (promptQueueStore.getByClientMessageId("retry-1")?.status !== "completed") {
        assert.ok(Date.now() < completedDeadline, "explicit retry should complete");
        await delay(5);
      }
      const entry = promptQueueStore.getByClientMessageId("retry-1");
      assert.equal(entry?.attempts, 2);
      assert.deepEqual(entry?.payload, {});

      const replay = syncEventStore.readAfter({
        namespace: resolveSyncNamespace("main"),
        laneKey: "test::test::main",
      });
      const lifecycle = replay.events.filter((event) => event.type === "prompt_queue");
      assert.equal(lifecycle.length, 1);
      assert.equal(lifecycle[0]?.payload.entry.status, "completed");
      assert.ok(Number(lifecycle[0]?.seq) > 0);
    } finally {
      client.terminate();
    }
  });

  it("reports an obsolete-generation failure with the row's own generation", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });

    // Collect every frame for the whole test. Adding and removing listeners
    // around the reset races with the very events under assertion.
    const frames: WsJson[] = [];
    const collect = (raw: RawData): void => {
      try {
        frames.push(JSON.parse(raw.toString("utf8")) as WsJson);
      } catch {
        // ignore non-JSON frames
      }
    };
    const waitForFrame = async (predicate: (msg: WsJson) => boolean, timeoutMs = 5000): Promise<WsJson> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        assert.ok(Date.now() < deadline, "timed out waiting for a ws frame");
        await delay(5);
      }
    };

    try {
      await waitForWsOpen(client);
      client.on("message", collect);

      // Park the first prompt inside the agent so the lane stays busy and the
      // second one is left queued. Moving the generation on while a row is still
      // queued is the real shape of stranded work: the row is written under
      // generation 1 but only fails once generation 2 is live.
      let releaseAgent!: () => void;
      holdAgentRequests = new Promise<void>((resolve) => { releaseAgent = resolve; });
      client.send(JSON.stringify({ type: "prompt", payload: "occupy the lane", client_message_id: "occupier-1" }));
      client.send(JSON.stringify({ type: "prompt", payload: "stranded work", client_message_id: "stranded-1" }));

      const runningDeadline = Date.now() + 3000;
      while (promptQueueStore.getByClientMessageId("occupier-1")?.status !== "running") {
        assert.ok(Date.now() < runningDeadline, "first prompt should occupy the lane");
        await delay(5);
      }
      assert.equal(promptQueueStore.getByClientMessageId("stranded-1")?.status, "queued");

      client.send(JSON.stringify({ type: "clear_history" }));
      const reset = await waitForFrame((msg) => msg.type === "session_reset");
      assert.equal(reset.laneGeneration, 2);

      holdAgentRequests = null;
      releaseAgent();
      const event = await waitForFrame(
        (msg) => msg.type === "prompt_queue" && (msg.entry as Record<string, unknown>)?.clientMessageId === "stranded-1"
          && (msg.entry as Record<string, unknown>)?.status === "failed",
      );

      // The event is routed to whichever sockets own the lane now, but the row it
      // reports must keep its own generation. A client decides whether it may
      // reuse the client id from exactly this field, and a rewritten value would
      // produce a retry the server rejects as a different prompt scope.
      assert.equal((event.entry as Record<string, unknown>).laneGeneration, 1);
    } finally {
      holdAgentRequests = null;
      client.off("message", collect);
      client.terminate();
    }
  });

  it("broadcasts a persisted user delta to both lane connections without replacing history", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const sender = new WebSocket(url, protocols, { origin: "http://localhost" });
    const sibling = new WebSocket(url, protocols, { origin: "http://localhost" });
    const frames: WsJson[] = [];
    for (const client of [sender, sibling]) client.on("message", (raw) => frames.push(JSON.parse(raw.toString("utf8"))));

    try {
      await Promise.all([waitForWsOpen(sender), waitForWsOpen(sibling)]);

      const isQueuedUser = (msg: WsJson): boolean => msg.type === "user" && msg.clientMessageId === "m2";
      const siblingUser = waitForWsMessage(sibling, isQueuedUser, 2000);
      const senderUser = waitForWsMessage(sender, isQueuedUser, 2000);
      const senderAck = waitForWsMessage(sender, (msg) => msg.type === "ack" && msg.client_message_id === "m2", 2000);
      const siblingInFlight = waitForWsMessage(
        sibling,
        (msg) => msg.type === "in_flight" && msg.inFlight === true,
        2000,
      );

      sender.send(JSON.stringify({ type: "command", payload: "echo slow" }));
      sender.send(JSON.stringify({ type: "command", payload: "echo queued", client_message_id: "m2" }));

      const [user, senderCopy, ack, inFlight] = await Promise.all([siblingUser, senderUser, senderAck, siblingInFlight]);
      assert.equal(user.text, "echo queued");
      assert.equal(user.kind, "client_message_id:m2");
      assert.ok(Number.isSafeInteger(user.seq) && Number(user.seq) > 0);
      assert.deepEqual(senderCopy, user);
      assert.equal(ack.duplicate, false);
      assert.equal(inFlight.inFlight, true);
      assert.equal(frames.some((frame) => frame.type === "history"), false);
      const replay = syncEventStore.readAfter({ namespace: resolveSyncNamespace("main"), laneKey: "test::test::main" });
      assert.equal(replay.events.filter((event) => event.payload.clientMessageId === "m2").length, 1);
      assert.equal(replay.events.some((event) => event.type === "history"), false);
    } finally {
      try {
        sender.terminate();
      } catch {
        // ignore
      }
      try {
        sibling.terminate();
      } catch {
        // ignore
      }
    }
  });
});

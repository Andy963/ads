import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { type RawData } from "ws";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";
import { DirectoryManager } from "../../server/sessions/directoryManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import { resolveSyncNamespace } from "../../server/web/server/sync/lane.js";

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
  let lock: AsyncLock;
  let unblockCommands: (() => void) | null;
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
    const createSession = ({ cwd }: { cwd: string }): HybridOrchestrator => new HybridOrchestrator({
      initialWorkingDirectory: cwd,
      adapters: [{
        id: "codex",
        metadata: { id: "codex", name: "Preflight fixture", capabilities: ["text"] },
        send: async () => ({ response: "Fixture reply", usage: null, agentId: "codex" }),
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
      const matched = entries.filter((entry) => entry.kind === `client_message_id:${clientMessageId}`);

      assert.equal(ack.duplicate, false);
      assert.equal(matched.length, 1);
      assert.equal(matched[0]?.role, "user");
      assert.equal(matched[0]?.text, "queued prompt");
    } finally {
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

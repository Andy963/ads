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

async function waitForCondition(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("web/server/ws/interrupt", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  let runAdsCommandLineImpl: (command: string) => Promise<{ ok: boolean; output: string }>;
  let interruptControllers: Map<string, AbortController>;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-interrupt-"));
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
    const workerSessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const reviewerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    const plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    const reviewerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-reviewer" });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();
    const directoryManager = new DirectoryManager([workspaceRoot]);

    interruptControllers = new Map<string, AbortController>();
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
        interruptControllers,
        clientMetaByWs,
        clients,
        cwdStore: new Map(),
        cwdStorePath: process.env.ADS_STATE_DB_PATH,
        persistCwdStore: () => {},
      },
      sessions: {
        workerSessionManager,
        plannerSessionManager,
        reviewerSessionManager,
        getWorkspaceLock: () => lock,
        getPlannerWorkspaceLock: () => lock,
        getReviewerWorkspaceLock: () => lock,
      },
      history: {
        workerHistoryStore,
        plannerHistoryStore,
        reviewerHistoryStore,
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

  it("interrupt aborts an in-flight command without waiting for completion", async () => {
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

    const client = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(client);

    client.send(JSON.stringify({ type: "command", payload: "echo hello" }));
    await runStartedPromise;

    const interrupted = waitForWsMessage(
      client,
      (msg) => msg.type === "error" && msg.message === "已中断，输出可能不完整",
      1500,
    );

    client.send(JSON.stringify({ type: "interrupt" }));

    const result = await interrupted;
    assert.equal(result.type, "error");

    resolveRun?.({ ok: true, output: "done" });

    try {
      client.terminate();
    } catch {
      // ignore
    }
  });

  it("interrupt from another connection aborts the in-flight command for the same session", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];

    let runStarted: (() => void) | null = null;
    const runStartedPromise = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const runPromise = new Promise<{ ok: boolean; output: string }>(() => {});

    runAdsCommandLineImpl = async () => {
      runStarted?.();
      return await runPromise;
    };

    const clientA = new WebSocket(url, protocols, { origin: "http://localhost" });
    const clientB = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(clientA);
    await waitForWsOpen(clientB);

    clientA.send(JSON.stringify({ type: "command", payload: "echo hello" }));
    await runStartedPromise;

    const interrupted = waitForWsMessage(
      clientB,
      (msg) => msg.type === "error" && msg.message === "已中断，输出可能不完整",
      1500,
    );
    clientB.send(JSON.stringify({ type: "interrupt" }));

    const result = await interrupted;
    assert.equal(result.type, "error");

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

  it("disconnect aborts in-flight work and clears interruptControllers", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test-session", "ads-chat.main"];

    let runStarted: (() => void) | null = null;
    const runStartedPromise = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const runPromise = new Promise<{ ok: boolean; output: string }>(() => {});

    runAdsCommandLineImpl = async () => {
      runStarted?.();
      return await runPromise;
    };

    const client = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(client);

    client.send(JSON.stringify({ type: "command", payload: "echo hello" }));
    await runStartedPromise;
    assert.equal(interruptControllers.size, 1);

    client.terminate();

    await waitForCondition(() => interruptControllers.size === 0);
  });

  it("keeps in-flight work running when a sibling connection disconnects", async () => {
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
    const clientB = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(clientA);
    await waitForWsOpen(clientB);

    const resultPromise = waitForWsMessage(
      clientA,
      (msg) => msg.type === "result" && msg.ok === true && msg.output === "done",
      1500,
    );
    clientA.send(JSON.stringify({ type: "command", payload: "echo hello" }));
    await runStartedPromise;
    assert.equal(interruptControllers.size, 1);

    const closePromise = new Promise<void>((resolve) => {
      clientB.once("close", () => resolve());
    });
    clientB.terminate();
    await closePromise;

    assert.equal(interruptControllers.size, 1);
    resolveRun?.({ ok: true, output: "done" });

    const result = await resultPromise;
    assert.equal(result.output, "done");
    assert.equal(interruptControllers.size, 0);

    try {
      clientA.terminate();
    } catch {
      // ignore
    }
  });

  it("allows the remaining connection to interrupt after the original requester disconnects", async () => {
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
    const clientB = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(clientA);
    await waitForWsOpen(clientB);

    clientA.send(JSON.stringify({ type: "command", payload: "echo hello" }));
    await runStartedPromise;
    assert.equal(interruptControllers.size, 1);

    const requesterClosed = new Promise<void>((resolve) => {
      clientA.once("close", () => resolve());
    });
    clientA.terminate();
    await requesterClosed;

    assert.equal(interruptControllers.size, 1);

    const interruptedPromise = waitForWsMessage(
      clientB,
      (msg) => msg.type === "error" && msg.message === "已中断，输出可能不完整",
      1500,
    );
    clientB.send(JSON.stringify({ type: "interrupt" }));
    const interrupted = await interruptedPromise;
    assert.equal(interrupted.message, "已中断，输出可能不完整");
    assert.equal(interruptControllers.size, 0);

    resolveRun?.({ ok: true, output: "late output" });

    try {
      clientB.terminate();
    } catch {
      // ignore
    }
  });
});

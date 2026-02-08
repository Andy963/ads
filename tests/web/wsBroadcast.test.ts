import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { AsyncLock } from "../../src/utils/asyncLock.js";
import { HistoryStore } from "../../src/utils/historyStore.js";
import { SessionManager } from "../../src/telegram/utils/sessionManager.js";
import { NoopAgentAvailability } from "../../src/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../src/web/server/ws/server.js";

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

describe("web/server/ws/broadcast", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  let runAdsCommandLineImpl: (command: string) => Promise<{ ok: boolean; output: string }>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
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
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const historyStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test" });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();

    wss = attachWebSocketServer({
      server,
      workspaceRoot,
      allowedOrigins: new Set(),
      agentAvailability,
      maxClients: 10,
      pingIntervalMs: 0,
      maxMissedPongs: 0,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      traceWsDuplication: false,
      allowedDirs: [workspaceRoot],
      workspaceCache: new Map(),
      interruptControllers: new Map<import("ws").WebSocket, AbortController>(),
      clientMetaByWs,
      clients,
      cwdStore: new Map(),
      cwdStorePath: process.env.ADS_STATE_DB_PATH,
      persistCwdStore: () => {},
      sessionManager,
      plannerSessionManager,
      historyStore,
      ensureTaskContext: () => ({} as unknown as any),
      getWorkspaceLock: () => lock,
      getPlannerWorkspaceLock: () => lock,
      runAdsCommandLine: async (command) => await runAdsCommandLineImpl(command),
      sanitizeInput: (payload) => String(payload ?? ""),
      syncWorkspaceTemplates: () => {},
      isOriginAllowed: () => true,
      authenticateRequest: () => ({ ok: true, userId: "test" }),
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
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

  it("broadcasts command results to new connections after refresh", async () => {
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

    try {
      clientA.terminate();
    } catch {
      // ignore
    }

    const clientB = new WebSocket(url, protocols, { origin: "http://localhost" });
    await waitForWsOpen(clientB);

    const resultPromise = waitForWsMessage(clientB, (msg) => msg.type === "result" && msg.output === "done");
    resolveRun?.({ ok: true, output: "done" });

    const result = await resultPromise;
    assert.equal(result.type, "result");

    try {
      clientB.terminate();
    } catch {
      // ignore
    }
  });
});

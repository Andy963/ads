import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { AsyncLock } from "../../src/utils/asyncLock.js";
import { HistoryStore } from "../../src/utils/historyStore.js";
import { SessionManager } from "../../src/telegram/utils/sessionManager.js";
import { attachWebSocketServer } from "../../src/web/server/ws/server.js";

describe("web/server/ws/stability", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-stability-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();

    server = http.createServer();
    const clients = new Set<import("ws").WebSocket>();
    const clientMetaByWs = new Map<
      import("ws").WebSocket,
      { historyKey: string; sessionId: string; chatSessionId: string; connectionId: string; userId: number }
    >();
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const historyStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test" });
    const lock = new AsyncLock();

    wss = attachWebSocketServer({
      server,
      workspaceRoot,
      allowedOrigins: new Set(),
      maxClients: 10,
      pingIntervalMs: 30,
      maxMissedPongs: 1,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      traceWsDuplication: false,
      allowedDirs: [workspaceRoot],
      workspaceCache: new Map(),
      interruptControllers: new Map(),
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
      runAdsCommandLine: async () => ({ ok: true, output: "" }),
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

  it("terminates stale connections even if app-level messages are received", async () => {
    const url = `ws://127.0.0.1:${port}`;
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

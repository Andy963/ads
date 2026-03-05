import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { AsyncLock } from "../../server/utils/asyncLock.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import { SessionManager } from "../../server/telegram/utils/sessionManager.js";
import { NoopAgentAvailability } from "../../server/agents/health/agentAvailability.js";
import { attachWebSocketServer } from "../../server/web/server/ws/server.js";

describe("web/server/ws/maxClients", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-maxclients-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
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
    const workerSessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const reviewerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    const workerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-worker" });
    const plannerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-planner" });
    const reviewerHistoryStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test-reviewer" });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();

    wss = attachWebSocketServer({
      server,
      workspaceRoot,
      allowedOrigins: new Set(),
      agentAvailability,
      maxClients: 0,
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
      workerSessionManager,
      plannerSessionManager,
      reviewerSessionManager,
      workerHistoryStore,
      plannerHistoryStore,
      reviewerHistoryStore,
      ensureTaskContext: () => ({} as unknown as any),
      getWorkspaceLock: () => lock,
      getPlannerWorkspaceLock: () => lock,
      getReviewerWorkspaceLock: () => lock,
      promoteQueuedTasksToPending: () => {},
      broadcastToSession: () => {},
      runAdsCommandLine: async () => ({ ok: true, output: "" }),
      sanitizeInput: (payload) => String(payload ?? ""),
      syncWorkspaceTemplates: () => {},
      isOriginAllowed: () => true,
      authenticateRequest: () => ({ ok: true, userId: "test" }),
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

  it("treats maxClients=0 as unlimited", async () => {
    const url = `ws://127.0.0.1:${port}`;
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

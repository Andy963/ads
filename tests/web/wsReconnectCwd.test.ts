import { afterEach, beforeEach, describe, it } from "node:test";
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

describe("web/server/ws reconnect cwd restore", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let nextWorkspace: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-reconnect-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-workspace-"));
    nextWorkspace = path.join(workspaceRoot, "nested");
    fs.mkdirSync(nextWorkspace, { recursive: true });
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();

    server = http.createServer();
    const clients = new Set<import("ws").WebSocket>();
    const clientMetaByWs = new Map<import("ws").WebSocket, any>();
    const directoryManager = new DirectoryManager([workspaceRoot]);
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
        authenticateRequest: (req) => {
          const header = req.headers["x-user-id"];
          const userId = Array.isArray(header) ? header[0] : header;
          return { ok: true as const, userId: String(userId ?? "default") };
        },
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
        cwdStorePath: process.env.ADS_STATE_DB_PATH!,
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
        ensureTaskContext: () => ({} as any),
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

  it("restores cwd for the same identity after reconnect without leaking to another user", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.shared-session", "ads-chat.main"];

    const clientA = new WebSocket(url, protocols, { origin: "http://localhost", headers: { "x-user-id": "user-a" } });
    const firstWelcomePromise = waitForWsMessage(clientA, (msg) => msg.type === "welcome");
    await waitForWsOpen(clientA);
    await firstWelcomePromise;

    const cdResultPromise = waitForWsMessage(
      clientA,
      (msg) => msg.type === "result" && typeof msg.output === "string" && String(msg.output).includes(nextWorkspace),
    );
    clientA.send(JSON.stringify({ type: "command", payload: `/cd ${nextWorkspace}` }));
    await cdResultPromise;

    clientA.terminate();

    const reconnectA = new WebSocket(url, protocols, { origin: "http://localhost", headers: { "x-user-id": "user-a" } });
    const reconnectWelcomePromise = waitForWsMessage(reconnectA, (msg) => msg.type === "welcome");
    await waitForWsOpen(reconnectA);
    const welcomeA = await reconnectWelcomePromise;
    assert.equal((welcomeA.workspace as { path?: unknown }).path, nextWorkspace);

    const clientB = new WebSocket(url, protocols, { origin: "http://localhost", headers: { "x-user-id": "user-b" } });
    const otherWelcomePromise = waitForWsMessage(clientB, (msg) => msg.type === "welcome");
    await waitForWsOpen(clientB);
    const welcomeB = await otherWelcomePromise;
    assert.equal((welcomeB.workspace as { path?: unknown }).path, workspaceRoot);

    reconnectA.terminate();
    clientB.terminate();
  });
});

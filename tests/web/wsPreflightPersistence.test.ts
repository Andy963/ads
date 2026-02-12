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

describe("web/server/ws/preflight-persistence", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let server: http.Server;
  let port: number;
  let wss: import("ws").WebSocketServer;
  let historyStore: HistoryStore;
  const originalEnv = { ...process.env };

  beforeEach(async (t) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-ws-preflight-"));
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
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model");
    const plannerSessionManager = new SessionManager(0, 0, "read-only", "test-model");
    historyStore = new HistoryStore({ storagePath: process.env.ADS_STATE_DB_PATH, namespace: "test" });
    const lock = new AsyncLock();
    const agentAvailability = new NoopAgentAvailability();

    let unblock: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const runAdsCommandLine = async (): Promise<{ ok: boolean; output: string }> => {
      await blocked;
      return { ok: true, output: "" };
    };

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
      promoteQueuedTasksToPending: () => {},
      broadcastToSession: () => {},
      getWorkspaceLock: () => lock,
      getPlannerWorkspaceLock: () => lock,
      runAdsCommandLine,
      sanitizeInput: (payload) => String(payload ?? ""),
      syncWorkspaceTemplates: () => {},
      isOriginAllowed: () => true,
      authenticateRequest: () => ({ ok: true, userId: "test" }),
    });

    // Make sure tests can always unblock the pending command.
    t.after(() => {
      try {
        unblock?.();
      } catch {
        // ignore
      }
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

  it("acks and persists a queued command even if an earlier command is still running", async () => {
    const url = `ws://127.0.0.1:${port}`;
    const protocols = ["ads-v1", "ads-session.test", "ads-chat.main"];
    const client = new WebSocket(url, protocols, { origin: "http://localhost" });

    try {
      await waitForWsOpen(client);

      client.send(JSON.stringify({ type: "command", payload: "echo slow" }));
      client.send(JSON.stringify({ type: "command", payload: "echo queued", client_message_id: "m2" }));

      const ack = await waitForWsMessage(
        client,
        (msg) => msg.type === "ack" && msg.client_message_id === "m2",
        500,
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
});

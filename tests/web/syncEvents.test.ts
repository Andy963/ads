import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";
import { handleSyncRoutes } from "../../server/web/server/api/routes/sync.js";
import {
  resolveSharedWorkerSyncLaneKey,
  resolveSyncLaneKey,
} from "../../server/web/server/sync/lane.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import { createWebSocketHub } from "../../server/web/server/start/webSocketHub.js";
import { WEB_WORKER_NAMESPACE } from "../../server/web/server/start/webLaneResources.js";

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe("web sync events", () => {
  let tmpDir: string;
  let stateDbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-sync-events-"));
    stateDbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = stateDbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("normalizes the default HTTP session exactly like the WebSocket handshake", async () => {
    const workspaceRoot = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceRoot);
    const sessionId = deriveProjectSessionId(workspaceRoot);
    const laneKey = resolveSyncLaneKey({ authUserId: "u-1", sessionId, chatSessionId: "main" });
    const store = new SyncEventStore({ stateDbPath });
    store.append({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "history",
      payload: { type: "history", items: [{ role: "ai", text: "restored", ts: 1 }] },
    });

    const res = createRes();
    const handled = await handleSyncRoutes(
      {
        req: { method: "GET" } as any,
        res: res as any,
        url: new URL(
          `http://localhost/api/sync/events?sessionId=default&chatSessionId=main&workspace=${encodeURIComponent(workspaceRoot)}`,
        ),
        pathname: "/api/sync/events",
        auth: { userId: "u-1", username: "admin" },
      },
      {
        syncEventStore: store,
        defaultWorkspaceRoot: workspaceRoot,
        resolveWorkspaceRoot: () => workspaceRoot,
        workerHistoryStore: { get: () => [] },
        plannerHistoryStore: { get: () => [] },
      },
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body) as { events: Array<{ payload?: { items?: Array<{ text?: string }> } }> };
    assert.equal(payload.events[0]?.payload?.items?.[0]?.text, "restored");
  });

  it("persists project task events even when no WebSocket client is online", () => {
    const store = new SyncEventStore({ stateDbPath });
    const hub = createWebSocketHub({
      syncEventStore: store,
    });
    const sessionId = "project-session";

    hub.broadcastToSession(sessionId, {
      type: "task:event",
      event: "task:updated",
      data: { id: "task-1", status: "running" },
    });
    const result = store.readAfter({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey: resolveSharedWorkerSyncLaneKey(sessionId),
      afterSeq: 0,
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.type, "task:event");
    assert.equal(result.events[0]?.payload.event, "task:updated");
  });

  it("rejects worker task sync requests from the planner lane", async () => {
    const workspaceRoot = path.join(tmpDir, "planner-task-sync-workspace");
    fs.mkdirSync(workspaceRoot);
    const res = createRes();
    const handled = await handleSyncRoutes(
      {
        req: { method: "GET" } as any,
        res: res as any,
        url: new URL("http://localhost/api/sync/events?sessionId=default&chatSessionId=planner&channel=tasks"),
        pathname: "/api/sync/events",
        auth: { userId: "u-1", username: "admin" },
      },
      {
        syncEventStore: new SyncEventStore({ stateDbPath }),
        defaultWorkspaceRoot: workspaceRoot,
        resolveWorkspaceRoot: () => workspaceRoot,
        workerHistoryStore: { get: () => [] },
        plannerHistoryStore: { get: () => [] },
      },
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /only available to worker lanes/);
  });

  it("closes affected clients without broadcasting when the sync log append fails", () => {
    const sent: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const hub = createWebSocketHub({
      syncEventStore: { append: () => null } as unknown as SyncEventStore,
    });
    const ws = {
      readyState: 1,
      send: (text: string) => sent.push(text),
      close: (code: number, reason: string) => closed.push({ code, reason }),
    } as any;
    hub.clientMetaByWs.set(ws, {
      historyKey: "u::project-session::main",
      sessionId: "project-session",
      chatSessionId: "main",
      connectionId: "conn",
      authUserId: "u",
      sessionUserId: 1,
    });

    hub.broadcastToSession("project-session", { type: "task:event", event: "task:updated" });

    assert.deepEqual(sent, []);
    assert.deepEqual(closed, [{ code: 1011, reason: "sync persistence failed" }]);
  });

  it("merges user and project lanes in sequence order", () => {
    const store = new SyncEventStore({ stateDbPath });
    const userLane = "user-lane";
    const sharedLane = "shared-lane";
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey: userLane, type: "delta", payload: { type: "delta", delta: "A" } });
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey: sharedLane, type: "task:event", payload: { type: "task:event" } });

    const result = store.readAfterLanes({
      namespace: WEB_WORKER_NAMESPACE,
      laneKeys: [userLane, sharedLane],
      afterSeq: 0,
    });
    assert.deepEqual(result.events.map((event) => event.type), ["delta", "task:event"]);
    assert.equal(result.truncated, false);
  });

  it("marks a lane truncated only after retained events were actually removed", () => {
    const store = new SyncEventStore({ stateDbPath, maxEventsPerLane: 2 });
    const laneKey = "trimmed-lane";
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey, type: "delta", payload: { type: "delta", delta: "A" } });
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey, type: "delta", payload: { type: "delta", delta: "B" } });
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey, type: "delta", payload: { type: "delta", delta: "C" } });

    const result = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    assert.equal(result.truncated, true);
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events.map((event) => event.payload.delta), ["B", "C"]);
  });

  it("keeps the task sync channel separate from chat snapshots", async () => {
    const workspaceRoot = path.join(tmpDir, "truncated-workspace");
    fs.mkdirSync(workspaceRoot);
    const sessionId = deriveProjectSessionId(workspaceRoot);
    const sharedLaneKey = resolveSharedWorkerSyncLaneKey(sessionId);
    const store = new SyncEventStore({ stateDbPath, maxEventsPerLane: 1 });
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey: sharedLaneKey, type: "task:event", payload: { type: "task:event", event: "message:delta" } });
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey: sharedLaneKey, type: "task:event", payload: { type: "task:event", event: "task:completed" } });

    const res = createRes();
    await handleSyncRoutes(
      {
        req: { method: "GET" } as any,
        res: res as any,
        url: new URL("http://localhost/api/sync/events?sessionId=default&chatSessionId=main&channel=tasks&afterSeq=0"),
        pathname: "/api/sync/events",
        auth: { userId: "u-1", username: "admin" },
      },
      {
        syncEventStore: store,
        defaultWorkspaceRoot: workspaceRoot,
        resolveWorkspaceRoot: () => workspaceRoot,
        workerHistoryStore: { get: () => [] },
        plannerHistoryStore: { get: () => [] },
      },
    );

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body) as {
      truncated: boolean;
      snapshot?: { items?: Array<{ role?: string; text?: string }> };
      events?: Array<{ type?: string; payload?: { type?: string; event?: string } }>;
    };
    assert.equal(payload.truncated, true);
    assert.equal(payload.snapshot, null);
  });

  it("keeps a burst of ephemeral decoration from evicting conversation state", () => {
    const store = new SyncEventStore({ stateDbPath, maxEventsPerLane: 4, maxEphemeralEventsPerLane: 2 });
    const laneKey = "class-split-lane";
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey, type: "history", payload: { type: "history" } });
    for (let index = 0; index < 20; index += 1) {
      store.append({
        namespace: WEB_WORKER_NAMESPACE,
        laneKey,
        type: "command",
        payload: { type: "command", index },
      });
    }
    store.append({ namespace: WEB_WORKER_NAMESPACE, laneKey, type: "result", payload: { type: "result", ok: true } });

    const result = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    // Both durable events survive the flood, and dropping decoration must not
    // push the client onto the full-snapshot path.
    assert.deepEqual(
      result.events.filter((event) => event.type !== "command").map((event) => event.type),
      ["history", "result"],
    );
    assert.equal(result.events.filter((event) => event.type === "command").length, 2);
    assert.equal(result.truncated, false);
  });

  it("collapses a streaming turn into one resumable delta_snapshot row", () => {
    const store = new SyncEventStore({ stateDbPath });
    const laneKey = "stream-lane";
    const args = {
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "delta_snapshot",
      eventId: `stream:${laneKey}`,
    };
    const firstSeq = store.appendCoalesced({ ...args, payload: { type: "delta_snapshot", text: "Hel" } });
    const secondSeq = store.appendCoalesced({ ...args, payload: { type: "delta_snapshot", text: "Hello" } });

    const result = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.payload.text, "Hello");
    // A new seq is what makes a client whose cursor passed the old row still see the update.
    assert.ok(Number(secondSeq) > Number(firstSeq));

    // A client that already caught up to the first write still receives the latest text.
    const afterFirst = store.readAfter({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      afterSeq: Number(firstSeq),
    });
    assert.equal(afterFirst.events[0]?.payload.text, "Hello");

    store.deleteCoalesced(args);
    assert.equal(store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 }).events.length, 0);
  });
  it("preserves phase-segmented delta snapshots and phase_complete ordering through catch-up", () => {
    const store = new SyncEventStore({ stateDbPath });
    const laneKey = "phase-stream-lane";

    // Snapshot 1
    store.appendCoalesced({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "delta_snapshot",
      eventId: `stream:${laneKey}:0`,
      payload: { type: "delta_snapshot", text: "Phase 1 explanation" },
    });
    // Phase complete 1
    store.append({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "phase_complete",
      payload: { type: "phase_complete", phase: "assistant" },
    });
    // Snapshot 2
    store.appendCoalesced({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "delta_snapshot",
      eventId: `stream:${laneKey}:1`,
      payload: { type: "delta_snapshot", text: "Phase 2 explanation" },
    });
    // Phase complete 2
    store.append({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "phase_complete",
      payload: { type: "phase_complete", phase: "assistant" },
    });
    // Snapshot 3 (active)
    store.appendCoalesced({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: "delta_snapshot",
      eventId: `stream:${laneKey}:2`,
      payload: { type: "delta_snapshot", text: "Phase 3 in-flight" },
    });
    const result = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    const sequence = result.events.map((e) => `${e.type}:${(e.payload as any).text ?? (e.payload as any).phase}`);
    assert.deepEqual(sequence, [
      "delta_snapshot:Phase 1 explanation",
      "phase_complete:assistant",
      "delta_snapshot:Phase 2 explanation",
      "phase_complete:assistant",
      "delta_snapshot:Phase 3 in-flight",
    ]);
  });
});

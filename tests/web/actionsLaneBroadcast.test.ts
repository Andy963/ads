import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { createActionsLaneBroadcaster } from "../../server/web/server/start/actionsLaneBroadcast.js";
import { WEB_ACTIONS_NAMESPACE } from "../../server/web/server/start/webLaneResources.js";
import type { WebSocketClientMeta } from "../../server/web/server/start/webSocketHub.js";
import { resolveSyncLaneKey } from "../../server/web/server/sync/lane.js";
import { WebLaneGenerationStore } from "../../server/web/server/sync/laneGeneration.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import { canResumeTranscript } from "../../server/web/server/ws/transcriptResume.js";

describe("Actions lane sync broadcasting", () => {
  let tmpDir: string;
  let stateDbPath: string;
  const originalDbPath = process.env.ADS_STATE_DB_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-broadcast-"));
    stateDbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = stateDbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    if (originalDbPath === undefined) delete process.env.ADS_STATE_DB_PATH;
    else process.env.ADS_STATE_DB_PATH = originalDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists Actions output while disconnected so a valid cursor can catch it up", () => {
    const authUserId = "user-1";
    const sessionId = "project-1";
    const chatSessionId = "main";
    const logicalHistoryKey = resolveSyncLaneKey({ authUserId, sessionId, chatSessionId });
    const syncEventStore = new SyncEventStore({ stateDbPath });
    const laneGenerationStore = new WebLaneGenerationStore({ stateDbPath });
    const initialSeq = syncEventStore.append({
      namespace: WEB_ACTIONS_NAMESPACE,
      laneKey: logicalHistoryKey,
      type: "message",
      payload: { type: "message", role: "user", text: "Implement this" },
    });
    assert.notEqual(initialSeq, null);

    const broadcast = createActionsLaneBroadcaster({
      syncEventStore,
      laneGenerationStore,
      clientMetaByWs: new Map(),
      sendJson: () => assert.fail("disconnected lane must not receive a live frame"),
      warn: (message) => assert.fail(message),
    });

    broadcast({ type: "command", command: "npm test", output: "passed", jobId: "job-1", ts: 10 }, logicalHistoryKey, sessionId);
    broadcast({ type: "message", role: "assistant", text: "Reviewer: PASS", jobId: "job-1", ts: 11, raw: { internal: true } }, logicalHistoryKey, sessionId);
    broadcast({ type: "assistant_done", text: "PR merged successfully", jobId: "job-1", ts: 12 }, logicalHistoryKey, sessionId);

    const replay = syncEventStore.readAfterLanes({
      namespace: WEB_ACTIONS_NAMESPACE,
      laneKeys: [logicalHistoryKey],
      afterSeq: initialSeq!,
    });
    assert.equal(canResumeTranscript({
      resume: { afterSeq: initialSeq!, laneGeneration: 1 },
      laneGeneration: 1,
      hasHistory: true,
      sync: {
        namespace: WEB_ACTIONS_NAMESPACE,
        laneKeys: [logicalHistoryKey],
        store: syncEventStore,
      },
    }), true);
    assert.deepEqual(replay.events.map((event) => event.type), ["command", "message", "assistant_done"]);
    assert.equal(replay.events.at(-1)?.payload.text, "PR merged successfully");
    assert.equal("raw" in (replay.events[1]?.payload ?? {}), false);
  });

  it("sequences live frames only for the current lane generation", () => {
    const authUserId = "user-2";
    const sessionId = "project-2";
    const chatSessionId = "main";
    const logicalHistoryKey = resolveSyncLaneKey({ authUserId, sessionId, chatSessionId });
    const syncEventStore = new SyncEventStore({ stateDbPath });
    const laneGenerationStore = new WebLaneGenerationStore({ stateDbPath });
    laneGenerationStore.bumpGeneration(WEB_ACTIONS_NAMESPACE, logicalHistoryKey);
    const currentHistoryKey = resolveSyncLaneKey({ authUserId, sessionId, chatSessionId, generation: 2 });
    const previousSocket = {} as WebSocket;
    const currentSocket = {} as WebSocket;
    const frames = new Map<WebSocket, unknown[]>();
    const clientMetaByWs = new Map<WebSocket, WebSocketClientMeta>([
      [previousSocket, {
        historyKey: logicalHistoryKey,
        logicalHistoryKey,
        laneGeneration: 1,
        sessionId,
        chatSessionId,
        connectionId: "previous",
        authUserId,
        sessionUserId: 1,
      }],
      [currentSocket, {
        historyKey: currentHistoryKey,
        logicalHistoryKey,
        laneGeneration: 2,
        sessionId,
        chatSessionId,
        connectionId: "current",
        authUserId,
        sessionUserId: 1,
      }],
    ]);

    const broadcast = createActionsLaneBroadcaster({
      syncEventStore,
      laneGenerationStore,
      clientMetaByWs,
      sendJson: (ws, payload) => frames.set(ws, [...(frames.get(ws) ?? []), payload]),
      warn: (message) => assert.fail(message),
    });
    broadcast({ type: "action_job_updated", jobId: "job-2", status: "running" }, logicalHistoryKey, sessionId);

    assert.equal(frames.get(previousSocket)?.length ?? 0, 0);
    assert.equal(frames.get(currentSocket)?.length, 1);
    assert.equal((frames.get(currentSocket)?.[0] as { seq?: number }).seq, 1);
    assert.equal(syncEventStore.getLatestSeq(WEB_ACTIONS_NAMESPACE, currentHistoryKey), 1);
    assert.equal(syncEventStore.getLatestSeq(WEB_ACTIONS_NAMESPACE, logicalHistoryKey), 0);
  });

  it("keeps transient deltas out of the replay log but sequences their barrier", () => {
    const authUserId = "user-3";
    const sessionId = "project-3";
    const chatSessionId = "main";
    const logicalHistoryKey = resolveSyncLaneKey({ authUserId, sessionId, chatSessionId });
    const syncEventStore = new SyncEventStore({ stateDbPath });
    const laneGenerationStore = new WebLaneGenerationStore({ stateDbPath });
    const socket = {} as WebSocket;
    const frames: unknown[] = [];
    const broadcast = createActionsLaneBroadcaster({
      syncEventStore,
      laneGenerationStore,
      clientMetaByWs: new Map([[socket, {
        historyKey: logicalHistoryKey,
        logicalHistoryKey,
        laneGeneration: 1,
        sessionId,
        chatSessionId,
        connectionId: "live",
        authUserId,
        sessionUserId: 1,
      }]]),
      sendJson: (_ws, payload) => frames.push(payload),
      warn: (message) => assert.fail(message),
    });

    broadcast({ type: "delta", delta: "partial", jobId: "job-3" }, logicalHistoryKey, sessionId);

    assert.deepEqual(frames, [{ type: "delta", delta: "partial", jobId: "job-3", afterSeq: 0 }]);
    assert.equal(syncEventStore.getLatestSeq(WEB_ACTIONS_NAMESPACE, logicalHistoryKey), 0);
  });
});

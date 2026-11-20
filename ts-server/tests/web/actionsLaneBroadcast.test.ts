import assert from "node:assert/strict";
import { it } from "node:test";
import type { WebSocket } from "ws";

import { createActionsLaneBroadcaster } from "../../server/web/server/start/actionsLaneBroadcast.js";
import type { WebSocketClientMeta } from "../../server/web/server/start/webSocketHub.js";
import { WEB_ACTIONS_NAMESPACE } from "../../server/web/server/start/webLaneResources.js";

it("persists and broadcasts a Reviewer result only to its current Actions session", () => {
  const projectId = "project-1";
  const logicalHistoryKey = "user-1:project-1:main";
  const historyKey = `${logicalHistoryKey}:generation:2`;
  const targetSocket = {} as WebSocket;
  const staleSocket = {} as WebSocket;
  const sent: Array<{ socket: WebSocket; payload: unknown }> = [];
  const appended: Array<Record<string, unknown>> = [];
  const metadata = new Map<WebSocket, WebSocketClientMeta>([
    [targetSocket, {
      historyKey,
      logicalHistoryKey,
      laneGeneration: 2,
      sessionId: projectId,
      chatSessionId: "main",
      connectionId: "actions",
      authUserId: "user-1",
      sessionUserId: 1,
    }],
    [staleSocket, {
      historyKey: "other-history",
      sessionId: projectId,
      chatSessionId: "main",
      connectionId: "actions",
      authUserId: "user-2",
      sessionUserId: 2,
    }],
  ]);
  const broadcast = createActionsLaneBroadcaster({
    syncEventStore: {
      append: (input) => {
        appended.push(input as unknown as Record<string, unknown>);
        return 11;
      },
      getLatestSeq: () => 10,
    },
    laneGenerationStore: { getGeneration: () => 2 },
    clientMetaByWs: metadata,
    sendJson: (socket, payload) => sent.push({ socket, payload }),
    warn: (message) => { throw new Error(message); },
  });

  broadcast({
    type: "message",
    role: "assistant",
    text: "Reviewer PASS for PR #598",
    jobId: "review-job",
    kind: "action_review_result:review-job",
    eventId: "review-event",
    ts: 123,
  }, logicalHistoryKey, projectId, 2);

  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.namespace, WEB_ACTIONS_NAMESPACE);
  assert.equal(appended[0]?.laneKey, historyKey);
  assert.equal(appended[0]?.type, "message");
  assert.equal(appended[0]?.eventId, "review-event");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.socket, targetSocket);
  assert.equal((sent[0]?.payload as { seq: number }).seq, 11);
});

it("drops broadcasts from a stale Actions lane generation", () => {
  const sent: unknown[] = [];
  let appendCalls = 0;
  const broadcast = createActionsLaneBroadcaster({
    syncEventStore: {
      append: () => { appendCalls += 1; return 1; },
      getLatestSeq: () => 0,
    },
    laneGenerationStore: { getGeneration: () => 3 },
    clientMetaByWs: new Map(),
    sendJson: (_socket, payload) => sent.push(payload),
    warn: () => {},
  });

  broadcast({ type: "message", text: "stale" }, "history", "project-1", 2);

  assert.equal(appendCalls, 0);
  assert.deepEqual(sent, []);
});

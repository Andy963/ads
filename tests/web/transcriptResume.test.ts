import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canResumeTranscript, parseTranscriptResume } from "../../server/web/server/ws/transcriptResume.js";
import { sendInitialBootstrapMessages } from "../../server/web/server/ws/bootstrapDelivery.js";

describe("transcript resume handshake", () => {
  it("parses a non-secret cursor and generation from the initial handshake", () => {
    assert.deepEqual(parseTranscriptResume("/ws?afterSeq=12&laneGeneration=3"), { afterSeq: 12, laneGeneration: 3 });
    assert.deepEqual(parseTranscriptResume("/ws?afterSeq=0&laneGeneration=1"), { afterSeq: 0, laneGeneration: 1 });
  });

  for (const query of ["", "?afterSeq=1", "?afterSeq=-1&laneGeneration=1", "?afterSeq=1.5&laneGeneration=1", "?afterSeq=1e2&laneGeneration=1", "?afterSeq=9007199254740992&laneGeneration=1", "?afterSeq=1&laneGeneration=0"]) {
    it(`rejects an invalid cursor request ${query}`, () => {
      assert.equal(parseTranscriptResume(`/ws${query}`), undefined);
    });
  }

  it("checks retention only in the server-resolved authenticated lane", () => {
    let observed: unknown;
    const allowed = canResumeTranscript({
      resume: { afterSeq: 10, laneGeneration: 2 }, laneGeneration: 2, hasHistory: true,
      sync: { namespace: "web-worker", laneKeys: ["authenticated-lane:generation:2"], store: { readAfterLanes: (args) => {
        observed = args;
        return { events: [], latestSeq: 12, minAvailableSeq: 1, truncated: false, hasMore: false };
      } } },
    });
    assert.equal(allowed, true);
    assert.deepEqual(observed, { namespace: "web-worker", laneKeys: ["authenticated-lane:generation:2"], afterSeq: 10, limit: 1 });
  });

  it("falls back for retention loss, a rolled-back server, generation mismatch, and legacy history", () => {
    const base = {
      resume: { afterSeq: 10, laneGeneration: 2 }, laneGeneration: 2, hasHistory: true,
      sync: { namespace: "web-worker", laneKeys: ["lane"], store: { readAfterLanes: () => ({
        events: [], latestSeq: 12, minAvailableSeq: 1, truncated: false, hasMore: false,
      }) } },
    };
    assert.equal(canResumeTranscript({ ...base, laneGeneration: 3 }), false);
    assert.equal(canResumeTranscript({ ...base, resume: { afterSeq: 13, laneGeneration: 2 } }), false);
    assert.equal(canResumeTranscript({ ...base, resume: { afterSeq: 0, laneGeneration: 2 } }), false);
    assert.equal(canResumeTranscript({ ...base, sync: undefined }), false);
    assert.equal(canResumeTranscript({ ...base, sync: { ...base.sync, store: { readAfterLanes: () => ({ ...base.sync.store.readAfterLanes(), truncated: true }) } } }), false);
  });

  it("acknowledges an unchanged cache without history, preserving completion ids and active snapshots", () => {
    const sent: Array<Record<string, unknown>> = [];
    const args = {
      ws: {} as any,
      safeJsonSend: (_ws: unknown, payload: unknown) => sent.push(payload as Record<string, unknown>),
      sessionManager: {
        getContextRestoreMode: () => "thread_resumed", getSavedThreadId: () => "thread-1",
        getEffectiveState: () => ({ model: "test-model", modelReasoningEffort: "high", activeAgentId: "codex" }),
      } as any,
      orchestrator: { getActiveAgentId: () => "codex", getThreadId: () => "thread-1", listAgents: () => [] } as any,
      userId: 1, agentAvailability: {} as any, sessionId: "session-1", chatSessionId: "main",
      workspace: { path: "/tmp/workspace" }, historyKey: "lane", inFlight: false,
      historyStore: { get: () => [
        { role: "user", text: "Question", kind: "client_message_id:prompt-1", ts: 1 },
        { role: "ai", text: "Answer", ts: 2 },
      ] } as any,
      latestSeq: 12, laneGeneration: 2, resume: { afterSeq: 12, laneGeneration: 2 },
      sync: { namespace: "web-worker", laneKeys: ["lane"], store: { readAfterLanes: () => ({
        events: [], latestSeq: 12, minAvailableSeq: 1, truncated: false, hasMore: false,
      }) } },
      runtimeSnapshots: [{ type: "delta_snapshot", text: "Active answer", active: true, snapshotSeq: 12 }],
    };
    sendInitialBootstrapMessages(args);
    assert.equal(sent[0]?.historyMode, "resume");
    assert.equal(sent[0]?.bootstrapHistory, false);
    assert.deepEqual(sent[0]?.completedClientMessageIds, ["prompt-1"]);
    assert.equal(sent.some((frame) => frame.type === "history" || frame.type === "delta_snapshot"), false);
    sent.length = 0;
    sendInitialBootstrapMessages({ ...args, inFlight: true });
    assert.equal(sent.some((frame) => frame.type === "history"), false);
    assert.equal(sent.find((frame) => frame.type === "delta_snapshot")?.afterSeq, 12);
    sent.length = 0;
    sendInitialBootstrapMessages({ ...args, resume: undefined });
    assert.equal(sent[0]?.historyMode, "snapshot");
    assert.equal(sent.some((frame) => frame.type === "history"), true);
  });
});

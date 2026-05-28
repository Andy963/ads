import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import { preflightPersistAndAck, shouldPersistCommandMessage } from "../../server/web/server/ws/preflight.js";

describe("web/ws/preflight", () => {
  it("skips persistence for silent or cd commands", () => {
    assert.deepEqual(
      shouldPersistCommandMessage({
        sanitizeInput: (payload) => String(payload ?? ""),
        payload: "/cd /tmp",
      }),
      { ok: true, command: "/cd /tmp", shouldPersist: false },
    );
  });

  it("acks and dedupes persisted command messages by client_message_id", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight", maxEntriesPerSession: 20 });
    const sent: unknown[] = [];
    let broadcastPersistedHistoryCalls = 0;
    let broadcastInFlightCalls = 0;
    const warnings: string[] = [];
    const sanitizeInput = (payload: unknown) => String(payload ?? "");

    try {
      const first = preflightPersistAndAck({
        parsed: { type: "command", payload: "echo hi", client_message_id: "m1" },
        requestId: "req-1",
        clientMessageId: "m1",
        receivedAt: 1,
        historyStore,
        historyKey: "history-1",
        sanitizeInput,
        sendJson: (payload) => sent.push(payload),
        broadcastPersistedHistory: () => {
          broadcastPersistedHistoryCalls += 1;
        },
        broadcastInFlight: () => {
          broadcastInFlightCalls += 1;
        },
        traceWsDuplication: true,
        warn: (message) => warnings.push(message),
        sessionId: "session-1",
        userId: 7,
      });
      const second = preflightPersistAndAck({
        parsed: { type: "command", payload: "echo hi", client_message_id: "m1" },
        requestId: "req-2",
        clientMessageId: "m1",
        receivedAt: 2,
        historyStore,
        historyKey: "history-1",
        sanitizeInput,
        sendJson: (payload) => sent.push(payload),
        broadcastPersistedHistory: () => {
          broadcastPersistedHistoryCalls += 1;
        },
        broadcastInFlight: () => {
          broadcastInFlightCalls += 1;
        },
        traceWsDuplication: true,
        warn: (message) => warnings.push(message),
        sessionId: "session-1",
        userId: 7,
      });

      assert.deepEqual(first, { enqueue: true });
      assert.deepEqual(second, { enqueue: false });
      assert.deepEqual(sent, [
        { type: "ack", client_message_id: "m1", duplicate: false },
        { type: "ack", client_message_id: "m1", duplicate: true },
      ]);
      assert.equal(broadcastPersistedHistoryCalls, 1);
      assert.equal(broadcastInFlightCalls, 1);
      assert.equal(historyStore.get("history-1").filter((entry) => entry.kind === "client_message_id:m1").length, 1);
      assert.equal(warnings.length, 1);
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("persists prompt execution metadata and dedupes by client id", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight-prompt-meta", maxEntriesPerSession: 20 });
    const sent: unknown[] = [];
    const sanitizeInput = (payload: unknown) => {
      if (typeof payload === "string") return payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return String((payload as Record<string, unknown>).text ?? "");
      }
      return "";
    };

    try {
      const first = preflightPersistAndAck({
        parsed: {
          type: "prompt",
          payload: { text: "hello", agentId: "claude", model: "claude-sonnet", model_reasoning_effort: "high" },
          client_message_id: "p1",
        },
        requestId: "req-1",
        clientMessageId: "p1",
        receivedAt: 1,
        historyStore,
        historyKey: "history-1",
        sanitizeInput,
        sendJson: (payload) => sent.push(payload),
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-1",
        userId: 7,
      });
      const second = preflightPersistAndAck({
        parsed: {
          type: "prompt",
          payload: { text: "hello again", agentId: "codex", model: "gpt-4.1", model_reasoning_effort: "xhigh" },
          client_message_id: "p1",
        },
        requestId: "req-2",
        clientMessageId: "p1",
        receivedAt: 2,
        historyStore,
        historyKey: "history-1",
        sanitizeInput,
        sendJson: (payload) => sent.push(payload),
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-1",
        userId: 7,
      });

      const entries = historyStore.get("history-1");
      assert.deepEqual(first, { enqueue: true });
      assert.deepEqual(second, { enqueue: false });
      assert.deepEqual(sent, [
        { type: "ack", client_message_id: "p1", duplicate: false },
        { type: "ack", client_message_id: "p1", duplicate: true },
      ]);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.text, "hello");
      assert.match(String(entries[0]?.kind ?? ""), /^client_message_id:p1;prompt_meta:/);
      assert.match(String(entries[0]?.kind ?? ""), /agent=claude/);
      assert.match(String(entries[0]?.kind ?? ""), /model=claude-sonnet/);
      assert.match(String(entries[0]?.kind ?? ""), /effort=high/);
    } finally {
      historyStore.clear("history-1");
    }
  });
});

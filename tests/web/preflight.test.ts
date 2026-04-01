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
      assert.equal(historyStore.get("history-1").filter((entry) => entry.kind === "client_message_id:m1").length, 1);
      assert.equal(warnings.length, 1);
    } finally {
      historyStore.clear("history-1");
    }
  });
});

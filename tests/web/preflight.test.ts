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

  it("re-enqueues only explicitly recovered duplicate prompts that have no terminal result", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight-recovery", maxEntriesPerSession: 20 });
    const base = {
      requestId: "req-recovery",
      clientMessageId: "p-recovery",
      historyStore,
      historyKey: "history-recovery",
      sanitizeInput: (payload: unknown) =>
        typeof payload === "object" && payload !== null
          ? String((payload as Record<string, unknown>).text ?? "")
          : String(payload ?? ""),
      sendJson: () => {},
      traceWsDuplication: false,
      warn: () => {},
      sessionId: "session-1",
      userId: 7,
    };

    try {
      assert.deepEqual(
        preflightPersistAndAck({
          ...base,
          parsed: { type: "prompt", payload: { text: "recover me" }, client_message_id: "p-recovery" },
          receivedAt: 1,
        }),
        { enqueue: true },
      );
      assert.deepEqual(
        preflightPersistAndAck({
          ...base,
          parsed: {
            type: "prompt",
            payload: { text: "recover me", replay_incomplete: true },
            client_message_id: "p-recovery",
          },
          receivedAt: 2,
          inFlight: true,
        }),
        { enqueue: false },
      );
      assert.deepEqual(
        preflightPersistAndAck({
          ...base,
          parsed: {
            type: "prompt",
            payload: { text: "different text", replay_incomplete: true },
            client_message_id: "p-recovery",
          },
          receivedAt: 3,
          inFlight: false,
        }),
        { enqueue: false },
      );
      assert.deepEqual(
        preflightPersistAndAck({
          ...base,
          parsed: {
            type: "prompt",
            payload: { text: "recover me", replay_incomplete: true },
            client_message_id: "p-recovery",
          },
          receivedAt: 4,
          inFlight: false,
        }),
        { enqueue: true },
      );

      historyStore.add("history-recovery", { role: "ai", text: "done", ts: 5 });
      assert.deepEqual(
        preflightPersistAndAck({
          ...base,
          parsed: {
            type: "prompt",
            payload: { text: "recover me", replay_incomplete: true },
            client_message_id: "p-recovery",
          },
          receivedAt: 6,
          inFlight: false,
        }),
        { enqueue: false },
      );
    } finally {
      historyStore.clear("history-recovery");
    }
  });

  it("does not execute or acknowledge a prompt when durable persistence fails", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight-failure", maxEntriesPerSession: 20 });
    historyStore.addWithResult = () => "failed";
    const sent: unknown[] = [];
    const warnings: string[] = [];

    const result = preflightPersistAndAck({
      parsed: { type: "prompt", payload: "do not lose this", client_message_id: "p-failed" },
      requestId: "req-failed",
      clientMessageId: "p-failed",
      receivedAt: 1,
      historyStore,
      historyKey: "history-failed",
      sanitizeInput: (payload) => String(payload ?? ""),
      sendJson: (payload) => sent.push(payload),
      traceWsDuplication: false,
      warn: (message) => warnings.push(message),
      sessionId: "session-1",
      userId: 7,
    });

    assert.deepEqual(result, { enqueue: false });
    assert.deepEqual(sent, [{ type: "error", message: "消息保存失败，请重试" }]);
    assert.equal(warnings.length, 1);
  });

  it("merges effective execution metadata into existing prompt history entries", () => {
    const historyStore = new HistoryStore({
      namespace: "test-preflight-effective-meta",
      maxEntriesPerSession: 20,
    });

    try {
      historyStore.add("history-eff", {
        role: "user",
        text: "hi",
        ts: 1,
        kind: "client_message_id:p2;prompt_meta:agent=codex,model=gpt-4.1,effort=high",
      });

      const updated = historyStore.updatePromptExecutionMetadata("history-eff", "p2", {
        effectiveAgentId: "claude",
        effectiveModel: "claude-sonnet",
        effectiveModelReasoningEffort: "low",
      });
      assert.equal(updated, true);

      const entries = historyStore.get("history-eff");
      assert.equal(entries.length, 1);
      const kind = String(entries[0]?.kind ?? "");
      assert.match(kind, /^client_message_id:p2;prompt_meta:/);
      assert.match(kind, /agent=codex/);
      assert.match(kind, /model=gpt-4\.1/);
      assert.match(kind, /effort=high/);
      assert.match(kind, /eff_agent=claude/);
      assert.match(kind, /eff_model=claude-sonnet/);
      assert.match(kind, /eff_effort=low/);

      const noop = historyStore.updatePromptExecutionMetadata("history-eff", "missing", {
        effectiveAgentId: "claude",
      });
      assert.equal(noop, false);
    } finally {
      historyStore.clear("history-eff");
    }
  });

  it("upserts history entries by stable kind key without duplicating", () => {
    const historyStore = new HistoryStore({
      namespace: "test-preflight-upsert-kind",
      maxEntriesPerSession: 20,
    });

    try {
      const insertResult = historyStore.upsertEntryByKind("history-plan", {
        role: "status",
        text: JSON.stringify({ planId: "P1", status: "in_progress", items: [{ text: "step a", status: "pending" }] }),
        ts: 1000,
        kind: "plan:P1",
      });
      assert.equal(insertResult, "inserted");

      const updateResult = historyStore.upsertEntryByKind("history-plan", {
        role: "status",
        text: JSON.stringify({ planId: "P1", status: "in_progress", items: [{ text: "step a", status: "completed" }] }),
        ts: 1100,
        kind: "plan:P1",
      });
      assert.equal(updateResult, "updated");

      const entries = historyStore.get("history-plan");
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.kind, "plan:P1");
      assert.ok(entries[0]?.text.includes("completed"));
      assert.equal(entries[0]?.ts, 1100);

      const skipped = historyStore.upsertEntryByKind("history-plan", {
        role: "status",
        text: JSON.stringify({ planId: "P1", status: "in_progress", items: [{ text: "step a", status: "completed" }] }),
        ts: 1100,
        kind: "plan:P1",
      });
      assert.equal(skipped, "skipped");
      assert.equal(historyStore.get("history-plan").length, 1);
    } finally {
      historyStore.clear("history-plan");
    }
  });
});

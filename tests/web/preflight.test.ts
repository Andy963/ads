import fs from "node:fs";
import { SyncEventStore } from "../../server/web/server/sync/store.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import os from "node:os";
import path from "node:path";
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
    const persistedMessages: Array<{ clientMessageId: string; role: "user"; text: string }> = [];
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
        onPersistedMessage: (message) => persistedMessages.push(message),
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
        onPersistedMessage: (message) => persistedMessages.push(message),
      });

      const entries = historyStore.get("history-1");
      assert.deepEqual(first, { enqueue: true });
      assert.deepEqual(second, { enqueue: false });
      assert.deepEqual(persistedMessages, [{ clientMessageId: "p1", role: "user", text: "hello" }]);
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
  it("emits replayable user sync event after prompt persistence succeeds (Issue #143)", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight-user-sync", maxEntriesPerSession: 20 });
    const emittedUserEvents: any[] = [];
    const sanitizeInput = (p: any) => typeof p === "string" ? p : String(p?.text ?? "");

    try {
      const res = preflightPersistAndAck({
        parsed: {
          type: "prompt",
          payload: { text: "hello sync" },
          client_message_id: "u-sync-1",
        },
        requestId: "req-user-sync",
        clientMessageId: "u-sync-1",
        receivedAt: 1234567,
        historyStore,
        historyKey: "history-user-sync",
        sanitizeInput,
        sendJson: () => {},
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-1",
        userId: 7,
        emitUserSyncEvent: (ev) => { emittedUserEvents.push(ev); return { ok: true }; },
      });

      assert.deepEqual(res, { enqueue: true });
      assert.equal(emittedUserEvents.length, 1);
      assert.deepEqual(emittedUserEvents[0], {
        type: "user",
        clientMessageId: "u-sync-1",
        text: "hello sync",
        ts: 1234567,
        eventId: "user:u-sync-1",
      });
    } finally {
      historyStore.clear("history-user-sync");
    }
  });
  it("preserves stable eventId and does not duplicate user event on duplicate preflight (Issue #143 Finding 5)", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight-user-dedup", maxEntriesPerSession: 20 });
    const emittedUserEvents: any[] = [];
    const sanitizeInput = (p: any) => typeof p === "string" ? p : String(p?.text ?? "");

    try {
      const first = preflightPersistAndAck({
        parsed: { type: "prompt", payload: { text: "idempotent prompt" }, client_message_id: "u-idempotent-1" },
        requestId: "req-idem-1",
        clientMessageId: "u-idempotent-1",
        receivedAt: 5000,
        historyStore,
        historyKey: "history-idem-1",
        sanitizeInput,
        sendJson: () => {},
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-1",
        userId: 7,
        emitUserSyncEvent: (ev) => { emittedUserEvents.push(ev); return { ok: true }; },
      });
      const second = preflightPersistAndAck({
        parsed: { type: "prompt", payload: { text: "idempotent prompt" }, client_message_id: "u-idempotent-1" },
        requestId: "req-idem-2",
        clientMessageId: "u-idempotent-1",
        receivedAt: 6000,
        historyStore,
        historyKey: "history-idem-1",
        sanitizeInput,
        sendJson: () => {},
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-1",
        userId: 7,
        emitUserSyncEvent: (ev) => { emittedUserEvents.push(ev); return { ok: true }; },
      });
      assert.deepEqual(first, { enqueue: true });
      assert.deepEqual(second, { enqueue: false });
      assert.equal(emittedUserEvents.length, 1);
      assert.equal(emittedUserEvents[0]?.eventId, "user:u-idempotent-1");
      assert.equal(emittedUserEvents[0]?.clientMessageId, "u-idempotent-1");
    } finally {
      historyStore.clear("history-idem-1");
    }
  });
  it("verifies actual SyncEventStore row persistence, eventId, ts, and idempotency (Issue #143 Finding 4)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-preflight-sync-"));
    const stateDbPath = path.join(tmpDir, "state.db");
    const syncEventStore = new SyncEventStore({ stateDbPath });
    const historyStore = new HistoryStore({ storagePath: stateDbPath, namespace: "test-preflight-db-sync", maxEntriesPerSession: 20 });
    const laneKey = "lane-test-1";
    const namespace = "worker";
    const sanitizeInput = (p: any) => typeof p === "string" ? p : String(p?.text ?? "");

    try {
      const emitUserSyncEvent = (userEv: any) => {
        const seq = syncEventStore.append({
          namespace,
          laneKey,
          type: userEv.type,
          eventId: userEv.eventId,
          ts: userEv.ts,
          payload: userEv,
        });
        return { ok: seq !== null };
      };

      const first = preflightPersistAndAck({
        parsed: { type: "prompt", payload: { text: "db persisted prompt" }, client_message_id: "client-db-1" },
        requestId: "req-db-1",
        clientMessageId: "client-db-1",
        receivedAt: 777000,
        historyStore,
        historyKey: "history-db-1",
        sanitizeInput,
        sendJson: () => {},
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-db-1",
        userId: 1,
        emitUserSyncEvent,
      });

      const second = preflightPersistAndAck({
        parsed: { type: "prompt", payload: { text: "db persisted prompt" }, client_message_id: "client-db-1" },
        requestId: "req-db-2",
        clientMessageId: "client-db-1",
        receivedAt: 888000,
        historyStore,
        historyKey: "history-db-1",
        sanitizeInput,
        sendJson: () => {},
        traceWsDuplication: false,
        warn: () => {},
        sessionId: "session-db-1",
        userId: 1,
        emitUserSyncEvent,
      });

      assert.equal(first.enqueue, true);
      assert.equal(second.enqueue, false);

      const readResult = syncEventStore.readAfter({ namespace, laneKey, afterSeq: 0 });
      assert.equal(readResult.events.length, 1);
      const row = readResult.events[0];
      assert.equal(row?.type, "user");
      assert.equal(row?.eventId, "user:client-db-1");
      assert.equal(row?.ts, 777000);
      assert.equal(row?.payload.clientMessageId, "client-db-1");
      assert.equal(row?.payload.text, "db persisted prompt");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("fails preflight, returns error, rolls back prompt entry, and allows retry on user sync event append failure (Finding B)", () => {
    const historyStore = new HistoryStore({ namespace: "test-preflight-fail-sync", maxEntriesPerSession: 20 });
    const sent: unknown[] = [];
    const warnings: string[] = [];
    const sanitizeInput = (p: unknown): string => typeof p === "string" ? p : String((p as { text?: unknown })?.text ?? "");

    try {
      // 1. First attempt fails sync append
      const first = preflightPersistAndAck({
        parsed: { type: "prompt", payload: { text: "will fail sync" }, client_message_id: "client-fail-1" },
        requestId: "req-fail-1",
        clientMessageId: "client-fail-1",
        receivedAt: 999000,
        historyStore,
        historyKey: "history-fail-1",
        sanitizeInput,
        sendJson: (p) => sent.push(p),
        traceWsDuplication: false,
        warn: (m) => warnings.push(m),
        sessionId: "session-fail-1",
        userId: 1,
        emitUserSyncEvent: () => ({ ok: false }),
      });

      assert.equal(first.enqueue, false);
      assert.deepEqual(sent, [{ type: "error", message: "消息保存失败，请重试" }]);
      assert.equal(warnings.length, 1);
      // Ensure prompt was rolled back from historyStore
      assert.equal(historyStore.get("history-fail-1").length, 0);

      // 2. Immediate client retry with same clientMessageId now succeeds instead of being rejected as stale duplicate!
      const retry = preflightPersistAndAck({
        parsed: { type: "prompt", payload: { text: "will fail sync" }, client_message_id: "client-fail-1" },
        requestId: "req-fail-2",
        clientMessageId: "client-fail-1",
        receivedAt: 1000000,
        historyStore,
        historyKey: "history-fail-1",
        sanitizeInput,
        sendJson: (p) => sent.push(p),
        traceWsDuplication: false,
        warn: (m) => warnings.push(m),
        sessionId: "session-fail-1",
        userId: 1,
        emitUserSyncEvent: () => ({ ok: true }),
      });

      assert.equal(retry.enqueue, true);
      assert.equal(historyStore.get("history-fail-1").length, 1);
      assert.deepEqual(sent.at(-1), { type: "ack", client_message_id: "client-fail-1", duplicate: false });
    } finally {
      historyStore.clear("history-fail-1");
    }
  });
  it("removeByExactKind removes only matching entry and reports success", () => {
    const historyStore = new HistoryStore({ namespace: "test-remove-exact", maxEntriesPerSession: 20 });
    try {
      historyStore.add("session-1", { role: "user", text: "keep me", ts: 1000, kind: "kind:keep" });
      historyStore.add("session-1", { role: "user", text: "delete me", ts: 1001, kind: "kind:delete" });
      assert.equal(historyStore.get("session-1").length, 2);

      const removed = historyStore.removeByExactKind("session-1", "kind:delete");
      assert.equal(removed, true);
      const remaining = historyStore.get("session-1");
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.kind, "kind:keep");

      // Non-existent kind returns false
      assert.equal(historyStore.removeByExactKind("session-1", "kind:nonexistent"), false);
    } finally {
      historyStore.clear("session-1");
    }
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createPromptQueueStore } from "../../server/state/promptQueueStore.js";

describe("state/promptQueueStore", () => {
  let db: DatabaseType | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  const lane = {
    authUserId: "auth-1",
    userId: 7,
    sessionId: "session-1",
    chatSessionId: "main",
    historyKey: "auth-1::session-1::main:generation:1",
    logicalHistoryKey: "auth-1::session-1::main",
    laneNamespace: "auth-1::session-1",
    laneGeneration: 1,
    workspaceRoot: "/workspace/project",
  };

  it("persists accepted prompts idempotently before execution", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);

    const first = store.enqueue({
      ...lane,
      clientMessageId: "client-1",
      payload: { text: "hello", model: "auto" },
      createdAt: 1000,
    });
    const duplicate = store.enqueue({
      ...lane,
      clientMessageId: "client-1",
      payload: { text: "hello", model: "auto" },
      createdAt: 2000,
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.entry.id, first.entry.id);
    assert.deepEqual(duplicate.entry.payload, { text: "hello", model: "auto" });
    assert.equal(duplicate.entry.status, "queued");
    assert.equal(duplicate.entry.position, 0);
    assert.throws(
      () => store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "conflicting" } }),
      /different prompt payload/,
    );
  });

  it("executes each lane in FIFO order and reports queue positions", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    store.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });

    const queued = store.listLane(lane);
    assert.deepEqual(queued.map((entry) => entry.clientMessageId), ["client-1", "client-2"]);
    assert.deepEqual(queued.map((entry) => entry.position), [1, 2]);
    assert.equal(store.markRunning(queued[0]!.id, "worker-1", 2000), true);
    assert.equal(store.markCompleted(queued[0]!.id, "worker-1", 2100), true);

    const remaining = store.listLane(lane);
    assert.deepEqual(remaining.map((entry) => entry.status), ["completed", "queued"]);
    assert.deepEqual(store.listRecoverable().map((entry) => entry.clientMessageId), ["client-2"]);
  });

  it("recovers interrupted running work and retains terminal failures", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    const first = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    const second = store.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });

    assert.equal(store.markRunning(first.entry.id, "old-worker", 1000), true);
    assert.equal(store.markRunning(second.entry.id, "old-worker", 1000), true);
    assert.equal(store.recoverInterrupted("old-worker", 2000), 2);
    assert.equal(store.markFailed(second.entry.id, new Error("generation changed"), 3000), true);

    assert.equal(store.getByClientMessageId("client-1")?.status, "queued");
    assert.equal(store.getByClientMessageId("client-2")?.status, "failed");
    assert.equal(store.getByClientMessageId("client-2")?.lastError, "generation changed");
  });

  it("fences stale workers and requeues an explicit failed retry", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    const first = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    assert.equal(store.markRunning(first.entry.id, "old-worker", 1000), true);
    assert.equal(store.recoverInterrupted("old-worker", 1100), 1);
    assert.equal(store.markCompleted(first.entry.id, "old-worker", 1200), false);

    assert.equal(store.markRunning(first.entry.id, "new-worker", 1300), true);
    assert.equal(store.markFailed(first.entry.id, new Error("failed"), 1400, "new-worker"), true);
    const failed = store.getByClientMessageId("client-1");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.payload.text, "one");

    const retried = store.enqueue({
      ...lane,
      clientMessageId: "client-1",
      payload: { text: "one", replay_incomplete: true },
      retryFailed: true,
    });
    assert.equal(retried.duplicate, false);
    assert.equal(retried.entry.status, "queued");
    assert.equal(retried.entry.attempts, 2);
    assert.equal(retried.entry.lastError, null);
  });

  it("scrubs completed payloads while retaining conflict detection", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    const first = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "private" } });
    assert.equal(store.markRunning(first.entry.id, "worker-1", 1000), true);
    assert.equal(store.markCompleted(first.entry.id, "worker-1", 1100), true);
    assert.deepEqual(store.getByClientMessageId("client-1")?.payload, {});

    const duplicate = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "private" } });
    assert.equal(duplicate.duplicate, true);
    assert.throws(
      () => store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "different" } }),
      /different prompt payload/,
    );
  });

  it("claims queue ownership atomically and only reclaims a dead owner", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    assert.deepEqual(store.claimOwnership("owner-1", 101, 1000, 60_000, () => false), {
      claimed: true,
      previousOwnerId: null,
    });
    assert.deepEqual(store.claimOwnership("owner-2", 202, 1100, 60_000, () => true), {
      claimed: false,
      previousOwnerId: "owner-1",
    });
    assert.deepEqual(store.claimOwnership("owner-2", 202, 1100, 60_000, () => false), {
      claimed: true,
      previousOwnerId: "owner-1",
    });
    assert.equal(store.releaseOwnership("owner-2"), true);
  });
});

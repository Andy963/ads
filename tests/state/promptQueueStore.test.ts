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
    assert.throws(
      () => store.enqueue({
        ...lane,
        chatSessionId: "other",
        logicalHistoryKey: "auth-1::session-1::other",
        clientMessageId: "client-1",
        payload: { text: "hello", model: "auto" },
      }),
      /different prompt scope/,
    );
  });

  it("executes each lane in FIFO order and reports queue positions", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    assert.equal(store.claimOwnership("worker-1", 101, 1000, 60_000, () => false).claimed, true);
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

  it("marks interrupted running work failed instead of replaying it automatically", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    assert.equal(store.claimOwnership("old-worker", 101, 900, 60_000, () => false).claimed, true);
    const first = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    const second = store.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });

    assert.equal(store.markRunning(first.entry.id, "old-worker", 1000), true);
    assert.equal(store.markRunning(second.entry.id, "old-worker", 1000), true);
    assert.equal(store.claimOwnership("new-worker", 202, 2000, 60_000, () => false).claimed, true);
    assert.deepEqual(store.listInterrupted("old-worker", 2000).map((entry) => entry.clientMessageId), ["client-1", "client-2"]);
    assert.equal(store.failInterrupted(first.entry.id, "new-worker", "old-worker", new Error("interrupted"), 2000), true);
    assert.equal(store.failInterrupted(second.entry.id, "new-worker", "old-worker", new Error("interrupted"), 2000), true);

    assert.equal(store.getByClientMessageId("client-1")?.status, "failed");
    assert.equal(store.getByClientMessageId("client-2")?.status, "failed");
    // The store persists the caller-supplied reason; the service owns the wording.
    assert.equal(store.getByClientMessageId("client-1")?.lastError, "interrupted");
    assert.deepEqual(store.listRecoverable(), []);
  });

  it("fences stale workers and requeues an explicit failed retry", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    assert.equal(store.claimOwnership("old-worker", 101, 900, 60_000, () => false).claimed, true);
    const first = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    assert.equal(store.markRunning(first.entry.id, "old-worker", 1000), true);
    assert.equal(store.claimOwnership("new-worker", 202, 1100, 60_000, () => false).claimed, true);
    assert.equal(store.failInterrupted(first.entry.id, "new-worker", "old-worker", new Error("interrupted"), 1100), true);
    assert.equal(store.markCompleted(first.entry.id, "old-worker", 1200), false);

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
    assert.equal(retried.entry.attempts, 1);
    assert.equal(retried.entry.lastError, null);

    assert.equal(store.markRunning(first.entry.id, "new-worker", 1300), true);
    assert.equal(store.markFailed(first.entry.id, new Error("failed"), "new-worker", 1400), true);
    const retriedAgain = store.enqueue({
      ...lane,
      clientMessageId: "client-1",
      payload: { text: "one", replay_incomplete: true },
      retryFailed: true,
    });
    assert.equal(retriedAgain.duplicate, false);
    assert.equal(retriedAgain.entry.status, "queued");
    assert.equal(retriedAgain.entry.attempts, 2);
  });

  it("scrubs completed payloads while retaining conflict detection", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    assert.equal(store.claimOwnership("worker-1", 101, 900, 60_000, () => false).claimed, true);
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

  it("cancels a still queued prompt and blocks its id from re-entering the queue", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    const queued = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });
    store.enqueue({ ...lane, clientMessageId: "client-2", payload: { text: "two" } });

    const result = store.cancel({ ...lane, clientMessageId: "client-1" }, 1000);

    assert.equal(result.cancelled, true);
    assert.equal(result.reason, "cancelled");
    assert.equal(result.entry?.id, queued.entry.id);
    assert.equal(store.getByClientMessageId("client-1"), null);
    // Cancelling one prompt must leave the rest of the lane intact.
    assert.equal(store.getByClientMessageId("client-2")?.status, "queued");
    assert.throws(
      () => store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } }),
      /was cancelled/,
    );
  });

  it("refuses to cancel a running prompt so a queue delete cannot stop an in-flight turn", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    assert.equal(store.claimOwnership("worker-1", 101, 900, 60_000, () => false).claimed, true);
    const entry = store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } }).entry;
    assert.equal(store.markRunning(entry.id, "worker-1", 1000), true);

    const result = store.cancel({ ...lane, clientMessageId: "client-1" }, 1100);

    assert.equal(result.cancelled, false);
    assert.equal(result.reason, "not_queued");
    assert.equal(store.getByClientMessageId("client-1")?.status, "running");
    // No tombstone either: the id is still the live turn's identity, so the
    // agent's own completion must not be rejected as a replay.
    assert.equal(
      store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } }).duplicate,
      true,
    );
    assert.equal(store.markCompleted(entry.id, "worker-1", 1200), true);
  });

  it("treats a repeated cancellation as a no-op", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createPromptQueueStore(db);
    store.enqueue({ ...lane, clientMessageId: "client-1", payload: { text: "one" } });

    const first = store.cancel({ ...lane, clientMessageId: "client-1" }, 1000);
    const second = store.cancel({ ...lane, clientMessageId: "client-1" }, 2000);

    assert.equal(first.cancelled, true);
    assert.equal(second.cancelled, false);
    assert.equal(second.reason, "already_cancelled");
    assert.equal(second.entry, null);
  });
});

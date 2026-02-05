import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetDatabaseForTests } from "../../src/storage/database.js";
import { TaskStore } from "../../src/tasks/store.js";

describe("tasks/taskStore", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-store-"));
    dbPath = path.join(tmpDir, "tasks.db");
    process.env.ADS_DATABASE_PATH = dbPath;
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should create and fetch tasks", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T1", prompt: "Hello" });
    const fetched = store.getTask(task.id);
    assert.ok(fetched);
    assert.equal(fetched.id, task.id);
    assert.equal(fetched.status, "pending");
  });

  it("should claim next pending task and mark running", () => {
    const store = new TaskStore();
    const t1 = store.createTask({ title: "A", prompt: "P1", priority: 1 });
    store.createTask({ title: "B", prompt: "P2", priority: 0 });

    const claimed = store.claimNextPendingTask(Date.now());
    assert.ok(claimed);
    assert.equal(claimed.id, t1.id);
    assert.equal(claimed.status, "running");

    const none = store.claimNextPendingTask(Date.now());
    // second claim should not return the already-claimed task
    assert.ok(!none || none.id !== t1.id);
  });

  it("should allow reordering pending tasks via queueOrder", () => {
    const store = new TaskStore();
    const t1 = store.createTask({ title: "A", prompt: "P1", priority: 0 });
    const t2 = store.createTask({ title: "B", prompt: "P2", priority: 0 });
    const t3 = store.createTask({ title: "C", prompt: "P3", priority: 0 });

    const moved = store.movePendingTask(t3.id, "up");
    assert.ok(moved);

    const first = store.claimNextPendingTask(Date.now());
    assert.ok(first);
    assert.equal(first.id, t1.id);

    const second = store.claimNextPendingTask(Date.now());
    assert.ok(second);
    assert.equal(second.id, t3.id);

    // Remaining pending task should be the one that wasn't moved ahead.
    const remaining = store.claimNextPendingTask(Date.now());
    assert.ok(remaining);
    assert.equal(remaining.id, t2.id);
  });

  it("should reorder pending tasks via reorderPendingTasks", () => {
    const store = new TaskStore();
    const t1 = store.createTask({ title: "A", prompt: "P1", priority: 0 });
    const t2 = store.createTask({ title: "B", prompt: "P2", priority: 0 });
    const t3 = store.createTask({ title: "C", prompt: "P3", priority: 0 });

    store.reorderPendingTasks([t3.id, t1.id, t2.id]);

    const first = store.claimNextPendingTask(Date.now());
    assert.ok(first);
    assert.equal(first.id, t3.id);

    const second = store.claimNextPendingTask(Date.now());
    assert.ok(second);
    assert.equal(second.id, t1.id);

    const third = store.claimNextPendingTask(Date.now());
    assert.ok(third);
    assert.equal(third.id, t2.id);
  });

  it("should support partial reorderPendingTasks without requiring all pending ids", () => {
    const store = new TaskStore();
    const t1 = store.createTask({ title: "A", prompt: "P1", priority: 0 });
    const t2 = store.createTask({ title: "B", prompt: "P2", priority: 0 });
    const t3 = store.createTask({ title: "C", prompt: "P3", priority: 0 });

    // Only reorder a subset; other pending tasks should keep their relative position.
    store.reorderPendingTasks([t3.id, t2.id]);

    const first = store.claimNextPendingTask(Date.now());
    assert.ok(first);
    assert.equal(first.id, t1.id);

    const second = store.claimNextPendingTask(Date.now());
    assert.ok(second);
    assert.equal(second.id, t3.id);

    const third = store.claimNextPendingTask(Date.now());
    assert.ok(third);
    assert.equal(third.id, t2.id);
  });

  it("should add and list task messages", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P" });
    store.addMessage({
      taskId: task.id,
      planStepId: null,
      role: "user",
      content: "hi",
      createdAt: Date.now(),
    });
    store.addMessage({
      taskId: task.id,
      planStepId: null,
      role: "assistant",
      content: "hello",
      createdAt: Date.now(),
    });
    const messages = store.getMessages(task.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[1]?.role, "assistant");
  });

  it("should mark prompt injected once", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P" });
    const now = Date.now();

    assert.equal(store.markPromptInjected(task.id, now), true);
    assert.equal(store.markPromptInjected(task.id, now + 1), false);

    const updated = store.getTask(task.id);
    assert.ok(updated);
    assert.equal(updated.promptInjectedAt, now);
  });

  it("should save and load task contexts", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P" });
    store.saveContext(task.id, { contextType: "summary", content: "done" });
    const contexts = store.getContext(task.id);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.contextType, "summary");
    assert.equal(contexts[0]?.content, "done");
  });

  it("should persist conversation messages", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P" });
    const convId = task.threadId ?? `conv-${task.id}`;
    store.addConversationMessage({
      conversationId: convId,
      taskId: task.id,
      role: "user",
      content: "hello",
      createdAt: Date.now(),
    });
    store.addConversationMessage({
      conversationId: convId,
      taskId: task.id,
      role: "assistant",
      content: "world",
      createdAt: Date.now(),
    });
    const conv = store.getConversation(convId);
    assert.ok(conv);
    assert.equal(conv.id, convId);
    const msgs = store.getConversationMessages(convId);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.role, "user");
    assert.equal(msgs[1]?.role, "assistant");
  });

  it("should inherit thread id when requested", () => {
    const store = new TaskStore();
    const t1 = store.createTask({ title: "A", prompt: "P1" });
    const t2 = store.createTask({ title: "B", prompt: "P2", inheritContext: true });
    assert.ok(t1.threadId);
    assert.equal(t2.threadId, t1.threadId);
  });

  it("should dequeue queued tasks in FIFO order and skip cancelled", () => {
    const store = new TaskStore();
    const now = Date.now();
    const t1 = store.createTask({ title: "Q1", prompt: "P1" }, now, { status: "queued", queuedAt: now + 10 });
    const t2 = store.createTask({ title: "Q2", prompt: "P2" }, now, { status: "queued", queuedAt: now + 20 });
    const t3 = store.createTask({ title: "Q3", prompt: "P3" }, now, { status: "queued", queuedAt: now + 30 });

    store.updateTask(t2.id, { status: "cancelled" }, now);

    const d1 = store.dequeueNextQueuedTask(now);
    assert.ok(d1);
    assert.equal(d1.id, t1.id);
    assert.equal(d1.status, "pending");

    const d2 = store.dequeueNextQueuedTask(now);
    assert.ok(d2);
    assert.equal(d2.id, t3.id);
    assert.equal(d2.status, "pending");

    const d3 = store.dequeueNextQueuedTask(now);
    assert.equal(d3, null);
  });

  it("should set archivedAt when a task becomes completed", () => {
    const store = new TaskStore();
    const created = store.createTask({ title: "T", prompt: "P" });
    const now = Date.now();

    const completed = store.updateTask(created.id, { status: "completed" }, now);
    assert.equal(completed.status, "completed");
    assert.ok(completed.completedAt);

    // archivedAt is a new field; use an escape hatch so this test fails by assertion
    // before the implementation exists (instead of failing to compile).
    const archivedAt = (completed as unknown as { archivedAt?: unknown }).archivedAt;
    assert.equal(typeof archivedAt, "number");
    assert.equal(archivedAt, now);

    const fetched = store.getTask(created.id);
    assert.ok(fetched);
    const fetchedArchivedAt = (fetched as unknown as { archivedAt?: unknown }).archivedAt;
    assert.equal(fetchedArchivedAt, now);
  });

  it("should clear archivedAt when a completed task is reopened", () => {
    const store = new TaskStore();
    const created = store.createTask({ title: "T", prompt: "P" });
    const t1 = Date.now();
    store.updateTask(created.id, { status: "completed" }, t1);

    const reopened = store.updateTask(created.id, { status: "pending" }, t1 + 1);
    assert.equal(reopened.status, "pending");
    const reopenedArchivedAt = (reopened as unknown as { archivedAt?: unknown }).archivedAt;
    assert.equal(reopenedArchivedAt, null);
  });
});

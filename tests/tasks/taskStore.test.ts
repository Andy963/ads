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

  it("should claim next pending task and mark planning", () => {
    const store = new TaskStore();
    const t1 = store.createTask({ title: "A", prompt: "P1", priority: 1 });
    store.createTask({ title: "B", prompt: "P2", priority: 0 });

    const claimed = store.claimNextPendingTask(Date.now());
    assert.ok(claimed);
    assert.equal(claimed.id, t1.id);
    assert.equal(claimed.status, "planning");

    const none = store.claimNextPendingTask(Date.now());
    // second claim should not return the already-claimed task
    assert.ok(!none || none.id !== t1.id);
  });

  it("should set plan steps and update step status", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P" });
    store.setPlan(task.id, [
      { stepNumber: 1, title: "S1", description: "D1" },
      { stepNumber: 2, title: "S2" },
    ]);

    const plan = store.getPlan(task.id);
    assert.equal(plan.length, 2);
    assert.equal(plan[0]?.title, "S1");
    assert.equal(plan[0]?.status, "pending");

    store.updatePlanStep(task.id, 1, "running", Date.now());
    const plan2 = store.getPlan(task.id);
    assert.equal(plan2[0]?.status, "running");
    assert.ok(plan2[0]?.startedAt);
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
});

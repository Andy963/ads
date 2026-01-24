import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { TaskStore } from "../../src/agents/tasks/taskStore.js";
import { TaskResultSchema, TaskSpecSchema } from "../../src/agents/tasks/schemas.js";

describe("agents/tasks/taskStore", () => {
  beforeEach(() => {
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
  });

  it("persists task lifecycle fields", () => {
    const store = new TaskStore({
      workspaceRoot: process.cwd(),
      namespace: "test",
      sessionId: "s1",
      dbPath: ":memory:",
    });

    const spec = TaskSpecSchema.parse({
      taskId: "t_1",
      agentId: "claude",
      revision: 1,
      goal: "do something",
      constraints: [],
      deliverables: [],
      acceptanceCriteria: [],
      verification: { commands: [] },
    });

    store.upsertTask(spec, "PENDING");
    store.updateStatus(spec.taskId, "IN_PROGRESS");

    const result = TaskResultSchema.parse({
      taskId: spec.taskId,
      revision: 1,
      status: "submitted",
      summary: "done",
      changedFiles: ["src/a.ts"],
      howToVerify: ["npm test"],
      knownRisks: [],
      questions: [],
    });

    store.setResult(spec.taskId, result, "SUBMITTED");
    store.setVerification(spec.taskId, { enabled: false, results: [] });

    const tasks = store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, "t_1");
    assert.equal(tasks[0]?.status, "SUBMITTED");
    assert.equal(tasks[0]?.spec.goal, "do something");
    assert.equal(tasks[0]?.result?.summary, "done");
    const verification = tasks[0]?.verification as { enabled?: boolean } | undefined;
    assert.equal(verification?.enabled, false);
  });

  it("clears outputs for new revision", () => {
    const store = new TaskStore({
      workspaceRoot: process.cwd(),
      namespace: "test",
      sessionId: "s1",
      dbPath: ":memory:",
    });

    const spec = TaskSpecSchema.parse({
      taskId: "t_2",
      agentId: "gemini",
      revision: 1,
      goal: "do other thing",
      constraints: [],
      deliverables: [],
      acceptanceCriteria: [],
      verification: { commands: [] },
    });

    store.upsertTask(spec, "SUBMITTED");
    store.setResult(
      spec.taskId,
      TaskResultSchema.parse({
        taskId: spec.taskId,
        revision: 1,
        status: "submitted",
        summary: "ok",
        changedFiles: [],
        howToVerify: [],
        knownRisks: [],
        questions: [],
      }),
      "SUBMITTED",
    );
    store.setVerification(spec.taskId, { enabled: true, results: [{ ok: true }] });

    store.clearOutputs(spec.taskId);
    const reloaded = store.getTask(spec.taskId);
    assert.ok(reloaded);
    assert.equal(reloaded.result, undefined);
    assert.equal(reloaded.verification, undefined);
  });
});


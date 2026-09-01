import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { TaskStore } from "../../server/tasks/store.js";
import { createTaskQueueMetrics } from "../../server/web/server/taskQueue/metrics.js";
import { createTaskWorkflowFollowup } from "../../server/web/server/taskQueue/runtime.js";
import {
  buildReworkTaskInput,
  buildReviewTaskInput,
  extractPullRequestReference,
  parseReviewDecision,
} from "../../server/tasks/reviewWorkflow.js";

describe("tasks/reviewWorkflow", () => {
  let tmpDir: string;

  it("extracts explicit pull request references and review decisions", () => {
    assert.deepEqual(extractPullRequestReference("Implemented in https://github.com/acme/project/pull/85"), {
      number: 85,
      url: "https://github.com/acme/project/pull/85",
    });
    assert.deepEqual(extractPullRequestReference("PR #85 is ready"), { number: 85, url: null });
    assert.deepEqual(parseReviewDecision("Checks passed\nREVIEW_STATUS: rejected\nREVIEW_FEEDBACK: Fix the race"), {
      status: "rejected",
      feedback: "Fix the race",
    });
    assert.equal(parseReviewDecision("The review looks good"), null);
  });

  it("builds review and high-priority rework task inputs", () => {
    const source = {
      id: "development-1",
      title: "Implement Issue #80",
      prompt: "Create PR #85",
      model: "auto",
      agentId: "codex",
      maxRetries: 2,
    } as never;
    const review = buildReviewTaskInput({
      source,
      pullRequest: { number: 85, url: "https://github.com/acme/project/pull/85" },
      issueNumber: 80,
    });
    assert.equal(review.category, "review");
    assert.equal(review.priority, 10);
    assert.equal(review.parentTaskId, "development-1");
    assert.match(review.prompt, /REVIEW_STATUS: approved/);

    const rework = buildReworkTaskInput({
      reviewTask: { ...source, id: "review-1" } as never,
      pullRequest: { number: 85, url: null },
      feedback: "Fix the race",
    });
    assert.equal(rework.category, "rework");
    assert.equal(rework.priority, 50);
    assert.equal(rework.parentTaskId, "review-1");
    assert.match(rework.prompt, /Fix the race/);
  });

  it("persists categories and claims rework before normal pending work", () => {
    const previousDatabasePath = process.env.ADS_DATABASE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-workflow-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
    try {
      const store = new TaskStore();
      const normal = store.createTask({ id: "normal", prompt: "normal", priority: 0 });
      const rework = store.createTask({ id: "rework", prompt: "rework", category: "rework", priority: 50 });
      assert.equal(store.getTask(normal.id)?.category, "development");
      assert.equal(store.getTask(rework.id)?.category, "rework");
      assert.equal(store.claimNextPendingTask()?.id, rework.id);
    } finally {
      resetDatabaseForTests();
      if (previousDatabasePath === undefined) delete process.env.ADS_DATABASE_PATH;
      else process.env.ADS_DATABASE_PATH = previousDatabasePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates an idempotent review and rework chain from queue completion events", () => {
    const previousDatabasePath = process.env.ADS_DATABASE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-chain-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
    try {
      const store = new TaskStore();
      const taskQueue = { notifyNewTask: () => undefined };
      const ctx = {
        sessionId: "review-session",
        taskStore: store,
        taskQueue,
        metrics: createTaskQueueMetrics(),
      } as never;
      const source = store.createTask({
        id: "development-1",
        title: "Implement Issue #80",
        prompt: "Create PR #85",
      });
      const completedSource = store.updateTask(
        source.id,
        { status: "completed", result: "Created PR #85" },
        2,
      );

      createTaskWorkflowFollowup({
        ctx,
        task: completedSource,
        logger: { warn: () => undefined } as never,
        broadcastToSession: () => undefined,
      });
      createTaskWorkflowFollowup({
        ctx,
        task: completedSource,
        logger: { warn: () => undefined } as never,
        broadcastToSession: () => undefined,
      });
      const review = store.findChildTask(source.id, "review");
      assert.ok(review);
      assert.equal(review.priority, 10);

      const rejectedReview = store.updateTask(
        review.id,
        { status: "completed", result: "REVIEW_STATUS: rejected\nREVIEW_FEEDBACK: Fix the race" },
        3,
      );
      createTaskWorkflowFollowup({
        ctx,
        task: rejectedReview,
        logger: { warn: () => undefined } as never,
        broadcastToSession: () => undefined,
      });
      createTaskWorkflowFollowup({
        ctx,
        task: rejectedReview,
        logger: { warn: () => undefined } as never,
        broadcastToSession: () => undefined,
      });
      const rework = store.findChildTask(review.id, "rework");
      assert.ok(rework);
      assert.equal(rework.priority, 50);
      assert.match(rework.prompt, /Fix the race/);
      store.createTask({ id: "normal-pending", prompt: "Normal work", priority: 0 });
      assert.equal(store.claimNextPendingTask()?.id, rework.id);
    } finally {
      resetDatabaseForTests();
      if (previousDatabasePath === undefined) delete process.env.ADS_DATABASE_PATH;
      else process.env.ADS_DATABASE_PATH = previousDatabasePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

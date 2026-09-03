import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { TaskStore } from "../../server/tasks/store.js";
import { createTaskQueueMetrics } from "../../server/web/server/taskQueue/metrics.js";
import { createTaskWorkflowFollowup, markReviewTaskStarted } from "../../server/web/server/taskQueue/runtime.js";
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
      reviewerModel: { model: "gpt-5.6-sol", agentId: "codex" },
    });
    assert.equal(review.category, "review");
    assert.equal(review.priority, 10);
    assert.equal(review.parentTaskId, "development-1");
    assert.equal(review.model, "gpt-5.6-sol");
    assert.equal(review.agentId, "codex");
    assert.notEqual(review.model, source.model);
    assert.equal(review.executionIsolation, "required");
    assert.match(review.prompt, /REVIEW_STATUS: approved/);

    const rework = buildReworkTaskInput({
      reviewTask: { ...source, id: "review-1" } as never,
      pullRequest: { number: 85, url: null },
      feedback: "Fix the race",
    });
    assert.equal(rework.category, "rework");
    assert.equal(rework.priority, 50);
    assert.equal(rework.parentTaskId, "review-1");
    assert.equal(rework.executionIsolation, "required");
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

  it("decommissions automated review and rework chain from queue completion events", () => {
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
        getReviewerModel: () => ({ model: "gpt-5.6-sol", agentId: "codex" }),
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
      assert.equal(review, null); return;
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

  it("does not inherit a worker model when the reviewer model is unset", () => {
    const previousDatabasePath = process.env.ADS_DATABASE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-unconfigured-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
    try {
      const store = new TaskStore();
      const broadcasts: unknown[] = [];
      const ctx = {
        sessionId: "review-session",
        taskStore: store,
        taskQueue: { notifyNewTask: () => undefined },
        metrics: createTaskQueueMetrics(),
        getReviewerModel: () => null,
      } as never;
      const source = store.createTask({
        id: "development-1",
        title: "Implement Issue #80",
        prompt: "Create PR #85",
        model: "gpt-5.6-luna",
        agentId: "codex",
      });
      const completedSource = store.updateTask(source.id, { status: "completed", result: "Created PR #85" }, 2);

      createTaskWorkflowFollowup({
        ctx,
        task: completedSource,
        logger: { warn: () => undefined } as never,
        broadcastToSession: (_sessionId, payload) => broadcasts.push(payload),
      });

      assert.equal(store.findChildTask(source.id, "review"), null);
      assert.equal(broadcasts.length, 0); return;
      const payload = broadcasts[0] as { type: string; event: string; data: {
        taskId: string;
        rootTaskId: string;
        event: string;
        message: string;
        review: { status: string; stateReason: string | null; controlState: string };
      } };
      assert.equal(payload.data.taskId, source.id);
      assert.equal(payload.data.rootTaskId, source.id);
      assert.equal(payload.data.event, "error");
      assert.equal(payload.data.message, "Reviewer model is not configured. Select an enabled concrete Reviewer model before reviewing tasks.");
      assert.equal(payload.data.review.status, "error");
      assert.equal(payload.data.review.stateReason, payload.data.message);
      assert.equal(payload.data.review.controlState, "needs_intervention");
      assert.equal((broadcasts[0] as { type: string }).type, "task:event");
      assert.equal((broadcasts[0] as { event: string }).event, "review:updated");
    } finally {
      resetDatabaseForTests();
      if (previousDatabasePath === undefined) delete process.env.ADS_DATABASE_PATH;
      else process.env.ADS_DATABASE_PATH = previousDatabasePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not let late review events override a manual terminal decision", () => {
    const previousDatabasePath = process.env.ADS_DATABASE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-late-event-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
    try {
      const store = new TaskStore();
      const source = store.createTask({
        id: "development-1",
        title: "Implement Issue #80",
        prompt: "Create PR #85",
        model: "worker-model",
        agentId: "worker",
        review: {
          required: true,
          status: "pending_review",
          rootTaskId: "development-1",
          pullRequestNumber: 85,
          reviewTaskId: "review-1",
        },
      });
      const review = store.createTask({
        id: "review-1",
        title: "Review PR #85",
        prompt: "Review the pull request",
        category: "review",
        parentTaskId: source.id,
        model: "reviewer-model",
        agentId: "reviewer",
      });
      store.updateTaskReview(source.id, { status: "approved", stateReason: "Approved by user." }, 2);

      const broadcasts: unknown[] = [];
      markReviewTaskStarted({
        ctx: {
          taskStore: store,
        } as never,
        task: store.updateTask(review.id, { status: "running" }, 3),
        broadcastToSession: (_sessionId, payload) => broadcasts.push(payload),
      });
      createTaskWorkflowFollowup({
        ctx: {
          sessionId: "review-session",
          taskStore: store,
          taskQueue: { notifyNewTask: () => undefined },
          metrics: createTaskQueueMetrics(),
          getReviewerModel: () => ({ model: "reviewer-model", agentId: "reviewer" }),
        } as never,
        task: store.updateTask(review.id, {
          status: "completed",
          result: "REVIEW_STATUS: rejected\nREVIEW_FEEDBACK: Fix the race",
        }, 4),
        logger: { warn: () => undefined } as never,
        broadcastToSession: (_sessionId, payload) => broadcasts.push(payload),
      });

      assert.equal(broadcasts.length, 0);
      assert.equal(store.getTask(source.id)?.review?.status, "approved");
      assert.equal(store.findChildTask(review.id, "rework"), null);
    } finally {
      resetDatabaseForTests();
      if (previousDatabasePath === undefined) delete process.env.ADS_DATABASE_PATH;
      else process.env.ADS_DATABASE_PATH = previousDatabasePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("opens the fuse after two automatic rework rounds", () => {
    const previousDatabasePath = process.env.ADS_DATABASE_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-fuse-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
    try {
      const store = new TaskStore();
      const ctx = {
        sessionId: "review-session",
        taskStore: store,
        taskQueue: { notifyNewTask: () => undefined },
        metrics: createTaskQueueMetrics(),
        getReviewerModel: () => ({ model: "reviewer-model", agentId: "reviewer" }),
      } as never;
      const followup = (task: Task): void => {
        createTaskWorkflowFollowup({
          ctx,
          task,
          logger: { warn: () => undefined } as never,
          broadcastToSession: () => undefined,
        });
      };
      const complete = (taskId: string, result: string): Task => {
        const task = store.updateTask(taskId, { status: "completed", result }, Date.now());
        followup(task);
        return task;
      };

      const source = store.createTask({ id: "development-1", title: "Issue #80", prompt: "Create PR #85", model: "worker-model", agentId: "worker" });
      complete(source.id, "Created PR #85");
      const review1 = store.findChildTask(source.id, "review");
      assert.equal(review1, null); return;
      complete(review1.id, "REVIEW_STATUS: rejected\nREVIEW_FEEDBACK: Fix one");
      const rework1 = store.findChildTask(review1.id, "rework");
      assert.ok(rework1);
      assert.equal(rework1.model, "worker-model");
      complete(rework1.id, "Updated PR #85");
      const review2 = store.findChildTask(rework1.id, "review");
      assert.ok(review2);
      complete(review2.id, "REVIEW_STATUS: rejected\nREVIEW_FEEDBACK: Fix two");
      const rework2 = store.findChildTask(review2.id, "rework");
      assert.ok(rework2);
      complete(rework2.id, "Updated PR #85 again");
      const review3 = store.findChildTask(rework2.id, "review");
      assert.ok(review3);
      complete(review3.id, "REVIEW_STATUS: rejected\nREVIEW_FEEDBACK: Fix three");

      const rootReview = store.getTask(source.id)?.review;
      assert.equal(rootReview?.status, "needs_human_intervention");
      assert.equal(rootReview?.reworkRound, 2);
      assert.equal(store.findChildTask(review3.id, "rework"), null);
    } finally {
      resetDatabaseForTests();
      if (previousDatabasePath === undefined) delete process.env.ADS_DATABASE_PATH;
      else process.env.ADS_DATABASE_PATH = previousDatabasePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

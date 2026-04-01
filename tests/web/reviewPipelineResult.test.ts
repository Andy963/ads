import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ReviewStore } from "../../server/tasks/reviewStore.js";
import { TaskStore } from "../../server/tasks/store.js";
import { finalizeReviewDecision } from "../../server/web/server/taskQueue/reviewPipelineResult.js";

describe("web/taskQueue reviewPipelineResult", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-pipeline-result-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-pipeline-result-workspace-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "ads.db");
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
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates queue artifacts, skips apply-back on rejected reviews, and broadcasts the outcome", async () => {
    const taskStore = new TaskStore({ workspacePath: workspaceRoot });
    const reviewStore = new ReviewStore({ workspacePath: workspaceRoot });
    const task = taskStore.createTask({
      title: "Needs review",
      prompt: "Inspect the patch",
      model: "auto",
      reviewRequired: true,
    });
    const run = taskStore.createTaskRun({
      taskId: task.id,
      executionIsolation: "required",
      workspaceRoot,
      worktreeDir: path.join(workspaceRoot, ".review-worktree"),
      status: "completed",
      captureStatus: "ok",
      applyStatus: "pending",
    });
    const runningTask = taskStore.updateTask(task.id, { reviewStatus: "running" }, Date.now());
    const snapshot = reviewStore.createSnapshot({
      taskId: task.id,
      taskRunId: run.id,
      specRef: null,
      worktreeDir: path.join(workspaceRoot, ".review-worktree"),
      patch: {
        files: [{ path: "src/reject.ts", added: 1, removed: 0 }],
        diff: "diff --git a/src/reject.ts b/src/reject.ts\n+nope\n",
        truncated: false,
      },
      changedFiles: ["src/reject.ts"],
      lintSummary: "",
      testSummary: "",
    });
    const item = reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, Date.now());

    const sessionBroadcasts: unknown[] = [];
    const reviewerBroadcasts: unknown[] = [];
    const reviewerHistories: Array<{ role: string; text: string; ts: number; kind?: string }> = [];

    const result = await finalizeReviewDecision({
      ctx: {
        workspaceRoot,
        taskStore,
        reviewStore,
        getLock: () => ({
          runExclusive: async <T>(fn: () => Promise<T> | T) => await fn(),
        }),
      } as any,
      sessionId: "session-1",
      item,
      snapshot,
      runningTask,
      prompt: "review this",
      responseText: '{"verdict":"rejected","conclusion":"Needs more tests."}',
      verdict: { verdict: "rejected", conclusion: "Needs more tests." },
      broadcastToSession: (_sessionId, payload) => {
        sessionBroadcasts.push(payload);
      },
      broadcastToReviewerSession: (_sessionId, payload) => {
        reviewerBroadcasts.push(payload);
      },
      recordToReviewerHistories: (_sessionId, entry) => {
        reviewerHistories.push(entry);
      },
    });

    assert.equal(result.artifact.verdict, "rejected");
    assert.equal(result.artifact.snapshotId, snapshot.id);
    assert.equal(result.artifact.queueItemId, item.id);
    assert.equal(reviewStore.listArtifacts({ snapshotId: snapshot.id, limit: 10 }).length, 1);
    assert.equal(reviewStore.getQueueItem(item.id)?.status, "rejected");
    assert.equal(reviewStore.getQueueItem(item.id)?.conclusion, "Needs more tests.");
    assert.equal(taskStore.getTask(task.id)?.reviewStatus, "rejected");
    assert.equal(taskStore.getTask(task.id)?.reviewConclusion, "Needs more tests.");
    assert.equal(taskStore.getTaskRun(run.id)?.applyStatus, "skipped");
    assert.ok(
      sessionBroadcasts.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { event?: string; data?: { id?: string; reviewStatus?: string } }).event === "task:updated" &&
          (payload as { data?: { id?: string; reviewStatus?: string } }).data?.id === task.id &&
          (payload as { data?: { reviewStatus?: string } }).data?.reviewStatus === "rejected",
      ),
    );
    assert.ok(
      reviewerBroadcasts.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: string; output?: string }).type === "result" &&
          String((payload as { output?: string }).output ?? "").includes("[Review REJECTED]"),
      ),
    );
    assert.ok(
      reviewerBroadcasts.some(
        (payload) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: string }).type === "reviewer_artifact",
      ),
    );
    assert.deepEqual(reviewerHistories.map((entry) => entry.kind), ["review"]);
  });
});

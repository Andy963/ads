import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ReviewStore } from "../../server/tasks/reviewStore.js";
import { TaskStore } from "../../server/tasks/store.js";
import { createPendingReviewSnapshot } from "../../server/web/server/taskQueue/reviewPipelineSnapshot.js";

describe("web/taskQueue reviewPipelineSnapshot", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-pipeline-snapshot-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-pipeline-workspace-"));
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

  it("creates a pending review snapshot from the latest workspace patch context", () => {
    const taskStore = new TaskStore({ workspacePath: workspaceRoot });
    const reviewStore = new ReviewStore({ workspacePath: workspaceRoot });
    const task = taskStore.createTask({
      title: "Needs review",
      prompt: "Check the latest patch",
      model: "auto",
      reviewRequired: true,
    });
    const worktreeDir = path.join(workspaceRoot, ".review-worktree");
    const run = taskStore.createTaskRun({
      taskId: task.id,
      executionIsolation: "required",
      workspaceRoot,
      worktreeDir,
      status: "completed",
      captureStatus: "pending",
      applyStatus: "pending",
    });

    taskStore.saveContext(task.id, {
      contextType: "artifact:workspace_patch",
      content: JSON.stringify({
        paths: ["src/from-patch.ts"],
        patch: {
          files: [{ path: "src/from-patch.ts", added: 1, removed: 0 }],
          diff: "diff --git a/src/from-patch.ts b/src/from-patch.ts\n+ok\n",
          truncated: false,
        },
        createdAt: Date.now(),
      }),
    });
    taskStore.saveContext(task.id, {
      contextType: "artifact:changed_paths",
      content: JSON.stringify({ paths: ["src/from-changed-paths.ts"] }),
    });

    const result = createPendingReviewSnapshot({
      ctx: { workspaceRoot, taskStore, reviewStore } as any,
      task,
      now: Date.now(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.taskRunId, run.id);
    assert.equal(result.snapshot.taskRunId, run.id);
    assert.equal(result.snapshot.worktreeDir, worktreeDir);
    assert.deepEqual(result.snapshot.changedFiles, ["src/from-patch.ts"]);
    assert.equal(taskStore.getTaskRun(run.id)?.captureStatus, "ok");
  });

  it("fails when a dedicated review worktree is required but cannot be resolved", () => {
    const taskStore = new TaskStore({ workspacePath: workspaceRoot });
    const reviewStore = new ReviewStore({ workspacePath: workspaceRoot });
    const task = taskStore.createTask({
      title: "Needs isolated review",
      prompt: "Check the latest patch",
      model: "auto",
      modelParams: { bootstrap: { enabled: true } },
      reviewRequired: true,
    });
    const run = taskStore.createTaskRun({
      taskId: task.id,
      executionIsolation: "required",
      workspaceRoot,
      status: "completed",
      captureStatus: "pending",
      applyStatus: "pending",
    });

    taskStore.saveContext(task.id, {
      contextType: "artifact:workspace_patch",
      content: JSON.stringify({
        paths: ["src/isolation.ts"],
        patch: {
          files: [{ path: "src/isolation.ts", added: 1, removed: 0 }],
          diff: "diff --git a/src/isolation.ts b/src/isolation.ts\n+ok\n",
          truncated: false,
        },
        createdAt: Date.now(),
      }),
    });

    const result = createPendingReviewSnapshot({
      ctx: { workspaceRoot, taskStore, reviewStore } as any,
      task,
      now: Date.now(),
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.taskRunId, run.id);
    assert.equal(result.errorMessage, "worktree_unresolved");
    assert.equal(reviewStore.getLatestSnapshot(), null);
    assert.equal(taskStore.getTaskRun(run.id)?.captureStatus, "pending");
  });
});

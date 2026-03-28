import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { ReviewStore, toReviewArtifactSummary } from "../../server/tasks/reviewStore.js";
import { TaskStore } from "../../server/tasks/store.js";

describe("tasks/reviewStore artifacts", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-store-"));
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
  });

  it("persists review artifacts with stable lineage and snapshot linkage", () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ title: "Task 1", prompt: "Do work", model: "auto" });
    const store = new ReviewStore();
    const snapshot = store.createSnapshot({
      taskId: task.id,
      specRef: "spec/foo",
      worktreeDir: "/tmp/review-worktree",
      patch: { files: [{ path: "src/a.ts", added: 3, removed: 1 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+ok\n", truncated: false },
      changedFiles: ["src/a.ts"],
      lintSummary: "ok",
      testSummary: "ok",
    });

    assert.equal(store.getLatestSnapshot()?.id, snapshot.id);
    assert.equal(store.getLatestSnapshot()?.worktreeDir, "/tmp/review-worktree");

    const first = store.createArtifact({
      taskId: snapshot.taskId,
      snapshotId: snapshot.id,
      scope: "reviewer",
      promptText: "Review the patch",
      responseText: "Looks correct overall.",
      summaryText: "Looks correct overall.",
      verdict: "analysis",
    });
    const second = store.createArtifact({
      taskId: snapshot.taskId,
      snapshotId: snapshot.id,
      scope: "reviewer",
      promptText: "Follow up",
      responseText: "Naming could be clearer.",
      summaryText: "Naming could be clearer.",
      verdict: "analysis",
      priorArtifactId: first.id,
    });

    const latest = store.getLatestArtifact({ snapshotId: snapshot.id });
    assert.ok(latest);
    assert.equal(latest?.id, second.id);
    assert.equal(latest?.priorArtifactId, first.id);
    assert.equal(latest?.snapshotId, snapshot.id);

    const listed = store.listArtifacts({ snapshotId: snapshot.id, limit: 10 });
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((artifact) => artifact.id),
      [second.id, first.id],
    );

    assert.deepEqual(toReviewArtifactSummary(second), {
      id: second.id,
      taskId: task.id,
      snapshotId: snapshot.id,
      queueItemId: null,
      scope: "reviewer",
      summaryText: "Naming could be clearer.",
      verdict: "analysis",
      priorArtifactId: first.id,
      createdAt: second.createdAt,
    });
  });
});

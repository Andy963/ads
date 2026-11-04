import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createActionJob,
  getActionJobById,
  supersedeReviewJobsForNewHead,
  updateActionJobStatus,
} from "../../server/state/actionJobStore.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import {
  acquireReviewQueueLease,
  getReviewQueueLease,
  releaseReviewQueueLease,
  renewReviewQueueLease,
} from "../../server/state/reviewQueueLeaseStore.js";

describe("review queue lifecycle", () => {
  const originalStateDbPath = process.env.ADS_STATE_DB_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-lifecycle-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    if (originalStateDbPath === undefined) delete process.env.ADS_STATE_DB_PATH;
    else process.env.ADS_STATE_DB_PATH = originalStateDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createReviewJob(id: string, overrides: {
    projectId?: string;
    prNumber?: number;
    headSha?: string;
    status?: "queued" | "verifying" | "completed" | "failed";
  } = {}): void {
    const db = getStateDatabase();
    createActionJob(db, {
      id,
      project_id: overrides.projectId ?? "project-1",
      job_kind: "pull_request_review",
      issue_id: 900,
      issue_title: "Review target",
      issue_snapshot: {
        title: "Review target",
        description: "Review this change.",
        acceptanceCriteria: ["Review the exact commit."],
        adrs: [],
      },
      branch: "codex/issue-900",
      base_sha: "base-sha",
      head_sha: overrides.headSha ?? "old-head",
      reviewer_profile_ids_json: "[]",
      pr_number: overrides.prNumber ?? 901,
      pr_url: "https://github.invalid/pull/901",
      auth_user_id: "user-1",
      chat_session_id: "main",
    });
    if (overrides.status && overrides.status !== "queued") {
      updateActionJobStatus(db, id, overrides.status, { current_step: `Fixture ${overrides.status}` });
    }
  }

  it("supersedes older heads without touching same-head retries or other PRs", () => {
    const db = getStateDatabase();
    createReviewJob("old-completed", { headSha: "old-head", status: "completed" });
    createReviewJob("old-queued", { headSha: "old-head" });
    createReviewJob("old-active", { headSha: "old-head", status: "verifying" });
    createReviewJob("unpinned", { headSha: "" });
    createReviewJob("same-head-retry", { headSha: "new-head", status: "completed" });
    createReviewJob("other-pr", { headSha: "old-head", prNumber: 902, status: "completed" });
    createReviewJob("other-project", { headSha: "old-head", projectId: "project-2", status: "completed" });

    const changed = supersedeReviewJobsForNewHead(db, {
      projectId: "project-1",
      prNumber: 901,
      branch: "codex/issue-900",
      keepHeadSha: "new-head",
      supersededByJobId: "new-review",
    });

    assert.equal(changed, 4);
    assert.equal(getActionJobById(db, "old-completed")?.status, "completed");
    assert.equal(getActionJobById(db, "old-completed")?.superseded_by_job_id, "new-review");
    assert.equal(getActionJobById(db, "old-queued")?.status, "cancelled");
    assert.equal(getActionJobById(db, "old-queued")?.current_step, "Superseded by a newer head commit");
    assert.equal(getActionJobById(db, "old-active")?.status, "cancelled");
    assert.equal(getActionJobById(db, "unpinned")?.status, "cancelled");
    assert.equal(getActionJobById(db, "same-head-retry")?.superseded_at, null);
    assert.equal(getActionJobById(db, "other-pr")?.superseded_at, null);
    assert.equal(getActionJobById(db, "other-project")?.superseded_at, null);
  });

  it("serializes lease ownership and reclaims an expired lease", () => {
    const db = getStateDatabase();
    assert.equal(acquireReviewQueueLease(db, "project-1", "owner-a", 1_000, 1_000), true);
    assert.equal(getReviewQueueLease(db, "project-1")?.owner_id, "owner-a");

    assert.equal(acquireReviewQueueLease(db, "project-1", "owner-b", 1_000, 1_100), false);
    assert.equal(renewReviewQueueLease(db, "project-1", "owner-a", 1_000, 1_100), true);
    assert.equal(getReviewQueueLease(db, "project-1")?.expires_at, 2_100);

    releaseReviewQueueLease(db, "project-1", "owner-a");
    assert.equal(getReviewQueueLease(db, "project-1"), null);

    assert.equal(acquireReviewQueueLease(db, "project-1", "owner-a", 10, 1_000), true);
    assert.equal(acquireReviewQueueLease(db, "project-1", "owner-b", 10, 1_020), true);
    assert.equal(getReviewQueueLease(db, "project-1")?.owner_id, "owner-b");
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import { LaneDispatchBus, type InteractiveReviewTarget } from "../../server/actions/bus.js";
import { createActionJob, updateActionJobStatus } from "../../server/state/actionJobStore.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";

describe("Actions Reviewer queue", () => {
  const originalStateDbPath = process.env.ADS_STATE_DB_PATH;
  let tmpDir: string;
  let repoDir: string;
  let baseCommit: string;
  let headCommit: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-review-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    spawnSync("git", ["init", "-b", "dev"], { cwd: repoDir });
    spawnSync("git", ["config", "user.email", "test@ads.test"], { cwd: repoDir });
    spawnSync("git", ["config", "user.name", "AdsTest"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
    baseCommit = git("rev-parse", "dev");
    spawnSync("git", ["checkout", "-b", "codex/issue-900"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "change.txt"), "change\n");
    spawnSync("git", ["add", "change.txt"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "implementation"], { cwd: repoDir });
    headCommit = git("rev-parse", "HEAD");

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const projectId = deriveProjectSessionId(repoDir);
    const now = Date.now();
    db.prepare(
      "INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-1", "user-1@test", "hash", now, now);
    db.prepare(
      "INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("user-1", projectId, repoDir, "Test project", "main", 0, now, now);
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    if (originalStateDbPath === undefined) delete process.env.ADS_STATE_DB_PATH;
    else process.env.ADS_STATE_DB_PATH = originalStateDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return String(spawnSync("git", args, { cwd: repoDir, encoding: "utf8" }).stdout).trim();
  }

  function target(overrides: Partial<InteractiveReviewTarget> = {}): InteractiveReviewTarget {
    return {
      projectId: deriveProjectSessionId(repoDir),
      repoPath: repoDir,
      authUserId: "user-1",
      branch: "codex/issue-900",
      prNumber: 901,
      prUrl: "https://github.invalid/pull/901",
      issue: {
        id: 900,
        title: "Interactive review",
        description: "Review this implementation.\n\n## Acceptance Criteria\n- Review the exact commit.",
        acceptanceCriteria: ["Review the exact commit."],
      },
      adrs: [],
      baseRef: "dev",
      headRef: "HEAD",
      baseCommit,
      headCommit,
      ...overrides,
    };
  }

  function createBus(
    getTarget: () => InteractiveReviewTarget,
    options: {
      reviewStatus?: "PASS" | "REJECT";
      testCommand?: string;
      interactiveVerificationTimeoutMs?: number;
      onReviewPrompt?: (prompt: string) => void;
      onMetadataRead?: (count: number) => void;
      openPullRequests?: Array<{ number: number; headRefName: string }>;
      onHistoryMessage?: (entry: { role: string; text: string; kind?: string }) => void;
      onBroadcast?: (payload: unknown) => void;
      reviewerRunner?: (prompt: string) => Promise<string>;
    } = {},
  ): LaneDispatchBus {
    let metadataReads = 0;
    const current = getTarget;
    return new LaneDispatchBus(getStateDatabase(), {
      testCommand: options.testCommand ?? "git status",
      interactiveVerificationTimeoutMs: options.interactiveVerificationTimeoutMs,
      interactiveGithubMetadataReader: () => {
        metadataReads += 1;
        options.onMetadataRead?.(metadataReads);
        const value = current();
        return {
          pullRequest: {
            number: value.prNumber,
            url: value.prUrl,
            state: "OPEN",
            headRefName: value.branch,
            baseRefName: "dev",
            baseRefOid: value.baseCommit!,
            headRefOid: value.headCommit!,
            body: "Closes #900",
          },
          openPullRequests: options.openPullRequests ?? [{ number: value.prNumber, headRefName: value.branch }],
          issue: {
            number: value.issue.id!,
            title: value.issue.title,
            body: value.issue.description,
          },
        };
      },
      interactiveOpenPullRequestReader: () => options.openPullRequests ?? [{
        number: current().prNumber,
        headRefName: current().branch,
      }],
      reviewerRunner: options.reviewerRunner ?? (async (prompt) => {
        options.onReviewPrompt?.(prompt);
        const status = options.reviewStatus ?? "PASS";
        return JSON.stringify({
          status,
          summary: status === "PASS" ? "Exact target reviewed" : "Defect found",
          defects: status === "PASS" ? [] : [{ file: "change.txt", severity: "blocker", description: "Fixture defect" }],
        });
      }),
      historyStore: {
        add: (_key, entry) => options.onHistoryMessage?.(entry),
      },
      broadcastToActionsLane: (payload) => options.onBroadcast?.(payload),
    });
  }

  function reviewRequest(reviewTarget: InteractiveReviewTarget, signal = new AbortController().signal) {
    return {
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: reviewTarget.authUserId,
      signal,
    };
  }

  it("pins a review job, runs verification, and records the verdict in Actions history", async () => {
    const reviewTarget = target();
    let reviewPrompt = "";
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    const broadcasts: unknown[] = [];
    const bus = createBus(() => reviewTarget, {
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
      onHistoryMessage: (entry) => history.push(entry),
      onBroadcast: (payload) => broadcasts.push(payload),
    });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const result = await tools.review_action();

    assert.equal(result.ok, true, result.error);
    assert.equal((result.verdict as { status: string }).status, "PASS");
    assert.ok(reviewPrompt.includes(`## Exact Diff Range:\n${baseCommit}..${headCommit}`));
    assert.ok(reviewPrompt.includes("Command: git status"));
    assert.ok(reviewPrompt.includes("Exit Code: 0"));
    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];
    assert.ok(job);
    assert.equal(job.status, "completed");
    assert.equal(job.job_kind, "pull_request_review");
    assert.equal(job.base_sha, baseCommit);
    assert.equal(job.head_sha, headCommit);
    assert.equal(job.pr_number, reviewTarget.prNumber);
    assert.equal(JSON.parse(job.issue_snapshot_json).acceptanceCriteria[0], "Review the exact commit.");
    assert.equal(JSON.parse(job.verification_report_json).exitCode, 0);
    assert.ok(history.some((entry) => entry.kind === `action_review_result:${job.id}`));
    assert.ok(broadcasts.some((payload) => (payload as { kind?: string }).kind === `action_review_result:${job.id}`));
    await tools.dispose();
  });

  it("returns REJECT as a completed review result without treating it as an operational failure", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, { reviewStatus: "REJECT" });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const result = await tools.review_action();

    assert.equal(result.ok, true);
    assert.equal((result.verdict as { status: string }).status, "REJECT");
    assert.equal(bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0]?.status, "completed");
    await tools.dispose();
  });

  it("fails interrupted review jobs and allows the same pinned target to be dispatched again", async () => {
    const reviewTarget = target();
    const db = getStateDatabase();
    createActionJob(db, {
      id: "interrupted-review",
      project_id: reviewTarget.projectId,
      job_kind: "pull_request_review",
      issue_id: reviewTarget.issue.id,
      issue_title: reviewTarget.issue.title,
      issue_snapshot: {
        title: reviewTarget.issue.title,
        description: reviewTarget.issue.description!,
        acceptanceCriteria: reviewTarget.issue.acceptanceCriteria!,
        adrs: [],
      },
      branch: reviewTarget.branch,
      base_sha: baseCommit,
      head_sha: headCommit,
      reviewer_profile_ids_json: "[]",
      pr_number: reviewTarget.prNumber,
      pr_url: reviewTarget.prUrl,
      auth_user_id: reviewTarget.authUserId,
      chat_session_id: "main",
    });
    updateActionJobStatus(db, "interrupted-review", "reviewing", {
      current_step: "Running Reviewer",
      review_verdicts_json: JSON.stringify([{ status: "PASS" }]),
    });
    const bus = createBus(() => reviewTarget);
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const result = await tools.review_action();

    assert.equal(result.ok, true, result.error);
    const jobs = bus.getJobs(reviewTarget.projectId, repoDir, "user-1");
    const interrupted = jobs.find((job) => job.id === "interrupted-review");
    assert.equal(interrupted?.status, "failed");
    assert.deepEqual(JSON.parse(interrupted?.review_verdicts_json ?? "[]"), []);
    assert.match(interrupted?.error_message ?? "", /no active worker/);
    assert.equal(jobs.filter((job) => job.status === "completed").length, 1);
    await tools.dispose();
  });

  it("fails closed when the target changes after the review was queued", async () => {
    let reviewTarget = target();
    const bus = createBus(() => reviewTarget, {
      onMetadataRead: (count) => {
        if (count === 2) reviewTarget = target({ prNumber: 902, prUrl: "https://github.invalid/pull/902" });
      },
    });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const result = await tools.review_action();
    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];

    assert.equal(result.ok, false);
    assert.match(String(result.error), /changed after dispatch/);
    assert.ok(job);
    assert.equal(job.status, "failed");
    assert.deepEqual(JSON.parse(job.review_verdicts_json), []);
    await tools.dispose();
  });

  it("serializes multiple queued reviews for the same project", async () => {
    const reviewTarget = target();
    let activeReviews = 0;
    let maxActiveReviews = 0;
    let completedReviews = 0;
    const bus = createBus(() => reviewTarget, {
      reviewerRunner: async () => {
        activeReviews += 1;
        maxActiveReviews = Math.max(maxActiveReviews, activeReviews);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeReviews -= 1;
        completedReviews += 1;
        return JSON.stringify({ status: "PASS", summary: "Reviewed", defects: [] });
      },
    });
    const db = getStateDatabase();
    for (const id of ["review-1", "review-2"]) {
      createActionJob(db, {
        id,
        project_id: reviewTarget.projectId,
        job_kind: "pull_request_review",
        issue_id: 900,
        issue_title: reviewTarget.issue.title,
        issue_snapshot: {
          title: reviewTarget.issue.title,
          description: reviewTarget.issue.description!,
          acceptanceCriteria: reviewTarget.issue.acceptanceCriteria!,
          adrs: [],
        },
        branch: reviewTarget.branch,
        base_sha: baseCommit,
        head_sha: headCommit,
        reviewer_profile_ids_json: "[]",
        pr_number: reviewTarget.prNumber,
        pr_url: reviewTarget.prUrl,
        auth_user_id: "user-1",
        chat_session_id: "main",
      });
    }

    await bus.processReviewQueue(reviewTarget.projectId, repoDir);

    assert.equal(completedReviews, 2);
    assert.equal(maxActiveReviews, 1);
    assert.deepEqual(bus.getJobs(reviewTarget.projectId, repoDir, "user-1").map((job) => job.status), ["completed", "completed"]);
  });

  it("does not cancel the durable queue when the originating Acopilot call aborts", async () => {
    const reviewTarget = target();
    const controller = new AbortController();
    const bus = createBus(() => reviewTarget, {
      onMetadataRead: (count) => {
        if (count === 2) controller.abort(new Error("Acopilot request aborted"));
      },
    });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget, controller.signal));

    await assert.rejects(tools.review_action(), /Acopilot request aborted/);
    await bus.processReviewQueue(reviewTarget.projectId, repoDir);

    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];
    assert.ok(job);
    assert.equal(job.status, "completed");
    assert.equal(JSON.parse(job.review_verdicts_json)[0].status, "PASS");
    await tools.dispose();
  });

  it("validates the Issue task slot without changing the workspace", async () => {
    spawnSync("git", ["checkout", "dev"], { cwd: repoDir });
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, { openPullRequests: [] });
    const result = await bus.beginInteractiveImplementation({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      issueId: 900,
    });

    assert.deepEqual(result, { ok: true, issueId: 900, branch: "dev" });
    assert.equal(git("branch", "--show-current"), "dev");
  });

  it("blocks a task when the base workspace is dirty or another PR owns the slot", async () => {
    spawnSync("git", ["checkout", "dev"], { cwd: repoDir });
    const reviewTarget = target();
    const dirtyBus = createBus(() => reviewTarget, { openPullRequests: [] });
    fs.writeFileSync(path.join(repoDir, "uncommitted.txt"), "preserve this change\n");
    await assert.rejects(dirtyBus.beginInteractiveImplementation({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      issueId: 900,
    }), /base workspace has uncommitted changes/);
    assert.equal(fs.readFileSync(path.join(repoDir, "uncommitted.txt"), "utf8"), "preserve this change\n");
    fs.rmSync(path.join(repoDir, "uncommitted.txt"));

    const busyBus = createBus(() => reviewTarget, { openPullRequests: [{ number: 902, headRefName: "codex/issue-902" }] });
    await assert.rejects(busyBus.beginInteractiveImplementation({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      issueId: 900,
    }), /Open pull request #902 owns the repository task slot/);
  });

  it("rejects review when the Issue-backed PR is missing or ambiguous", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, { openPullRequests: [] });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    await assert.rejects(tools.review_action(), /Only one open pull request/);
    assert.deepEqual(bus.getJobs(reviewTarget.projectId, repoDir, "user-1"), []);
    await tools.dispose();
  });

  it("fails closed when a changed ADR cannot be read", async () => {
    const adrDir = path.join(repoDir, "docs", "adr");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.symlinkSync("missing-target.md", path.join(adrDir, "0099-missing.md"));
    spawnSync("git", ["add", "docs/adr/0099-missing.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "add unreadable ADR fixture"], { cwd: repoDir });
    headCommit = git("rev-parse", "HEAD");
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget);

    await assert.rejects(bus.resolveInteractiveReviewTarget({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
    }), /Unable to read changed ADR 'docs\/adr\/0099-missing\.md'/);
  });

  it("fails an operational queue job when verification times out", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, {
      testCommand: "node -e setTimeout(()=>{},10000)",
      interactiveVerificationTimeoutMs: 50,
    });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const result = await tools.review_action();

    assert.equal(result.ok, false);
    assert.match(String(result.error), /timed out/);
    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];
    assert.equal(job?.status, "failed");
    assert.deepEqual(JSON.parse(job?.review_verdicts_json ?? "[]"), []);
    await tools.dispose();
  });
});

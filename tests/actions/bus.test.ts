import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import {
  classifyActionsFailure,
  LaneDispatchBus,
  validateGitEvidence,
} from "../../server/actions/bus.js";
import { handleActionRoutes, setBusInstance } from "../../server/web/server/api/routes/actions.js";
import { checkThreePointGate } from "../../server/actions/threePointGate.js";
import { updateActionJobStatus } from "../../server/state/actionJobStore.js";
import type { PullRequestStateResult } from "../../server/actions/pipeline.js";
import type { completeNativeChat } from "../../server/runtime/openAiCompatibleClient.js";
import { getDefaultRoleProfile } from "../../server/state/roleProfileStore.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";

describe("LaneDispatchBus & ThreePointCheckoutGate", () => {
  let tmpDir: string;
  let repoDir: string;
  let implementationCounter: number;
  const originalEnv = { ...process.env };

  function addWebProjectMapping(
    db: ReturnType<typeof getStateDatabase>,
    projectId: string,
    userId = "user-1",
  ): void {
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, `${userId}@test`, "test-password-hash", now, now);
    db.prepare(
      "INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(userId, projectId, repoDir, "Test Project", "main", 0, now, now);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-bus-test-"));
    implementationCounter = 0;
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();

    // Create a local git repo for testing git gates
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    spawnSync("git", ["init", "-b", "dev"], { cwd: repoDir });
    spawnSync("git", ["config", "user.email", "test@ads.test"], { cwd: repoDir });
    spawnSync("git", ["config", "user.name", "AdsTest"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Timed out waiting for condition");
  }

  function reviewerOptions(complete: typeof completeNativeChat) {
    return {
      reviewerModelResolver: (model: string) => ({ model, baseUrl: "https://reviewer.invalid/v1", apiKey: "fixture-key", provider: "openai" }),
      reviewerComplete: complete,
    };
  }
  function reviewerPayload() {
    const head = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).stdout).trim();
    return {
      issue: { title: "Review fixture" }, diff: "diff --git a/a.ts b/a.ts\n+ change",
      diffRange: { range: "dev...HEAD", baseRef: "dev", headRef: "HEAD", baseCommit: head, headCommit: head },
    };
  }

  function commitImplementation(label = "implementation"): void {
    implementationCounter += 1;
    const fileName = `${label}-${implementationCounter}.txt`;
    fs.writeFileSync(path.join(repoDir, fileName), `implementation ${implementationCounter}\n`);
    spawnSync("git", ["add", fileName], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", `implement ${label}`], { cwd: repoDir });
  }

  it("dispatches a job non-blockingly with formatted id and queued status", async (context) => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);
    const evaluate = context.mock.method(bus, "evaluateQueue", async () => ({ allowed: false }));

    const result = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      issueId: 277,
      issueTitle: "Acopilot & Actions refactor",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the queued job"],
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "queued");
    assert.ok(result.jobId.startsWith("job-"));
    assert.ok(result.jobId.includes("-277-"));
    // Dispatch must return the persisted queued state before auto-start runs;
    // wall-clock thresholds measure host SQLite contention, not this contract.
    assert.strictEqual(evaluate.mock.callCount(), 0);

    const stored = bus.getJob(result.jobId);
    assert.ok(stored);
    assert.strictEqual(stored.status, "queued");
    assert.strictEqual(stored.branch, "codex/issue-277");
    await Promise.resolve();
    assert.strictEqual(evaluate.mock.callCount(), 1);
  });

  it("auto-starts a dispatched job without a manual queue start when the queue is idle", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 601,
      issueTitle: "Auto start on dispatch",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify auto start"],
      repoPath: repoDir,
    });

    await waitFor(() => bus.getJob(job.jobId)?.status === "running");

    const runningJob = bus.getJob(job.jobId);
    const steps = JSON.parse(runningJob?.steps_json ?? "[]") as Array<{ status: string; step: string }>;
    assert.deepStrictEqual(steps.map((step) => step.status), ["queued", "running"]);
    assert.strictEqual(
      spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(),
      "codex/issue-601",
    );
  });

  it("does not double-start when a follow-up job is dispatched while another job is running", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const first = bus.dispatchJob({
      projectId: repoDir,
      issueId: 602,
      issueTitle: "First auto-started task",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the first job starts"],
      repoPath: repoDir,
    });
    await waitFor(() => bus.getJob(first.jobId)?.status === "running");

    const second = bus.dispatchJob({
      projectId: repoDir,
      issueId: 603,
      issueTitle: "Second task stays queued",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify no double start"],
      repoPath: repoDir,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondJob = bus.getJob(second.jobId);
    assert.strictEqual(secondJob?.status, "queued");
    assert.strictEqual(secondJob?.error_message, null);
    assert.strictEqual(
      spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(),
      "codex/issue-602",
    );
  });

  it("posts the failure stage and detail to the Actions chat stream when a job ends blocked", async () => {
    const db = getStateDatabase();
    const historyEntries: any[] = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        commitImplementation("blocked-failure");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "Should not run", defects: [] }),
      testCommand: "node -e process.exit(1)",
      historyStore: {
        add: (key, entry) => historyEntries.push({ key, entry }),
      },
      broadcastToActionsLane: (payload) => broadcasts.push(payload as Record<string, unknown>),
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 604,
      issueTitle: "Blocked failure surfacing",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify failure logs reach the chat stream"],
      repoPath: repoDir,
    });

    await waitFor(() => bus.getJob(job.jobId)?.status === "blocked");

    const failureEntry = historyEntries.find((h) => h.entry.kind === "action_blocked");
    assert.ok(failureEntry, "expected a persisted action_blocked chat entry");
    assert.strictEqual(failureEntry.entry.role, "assistant");
    assert.match(failureEntry.entry.text, /Verification failed:/);

    const failureBroadcast = broadcasts.find((payload) =>
      payload.type === "message"
      && typeof payload.text === "string"
      && payload.text.includes("Verification failed:"),
    );
    assert.ok(failureBroadcast, "expected a live chat broadcast with the failure detail");
    assert.strictEqual(failureBroadcast.role, "assistant");

    const blockedJob = bus.getJob(job.jobId);
    const statuses = (JSON.parse(blockedJob?.steps_json ?? "[]") as Array<{ status: string }>)
      .map((step) => step.status);
    assert.ok(statuses.includes("queued"));
    assert.ok(statuses.includes("running"));
    assert.ok(statuses.includes("verifying"));
    assert.ok(statuses.includes("blocked"));
  });

  it("posts a cancellation notice to the Actions chat stream", () => {
    const db = getStateDatabase();
    const historyEntries: any[] = [];
    const bus = new LaneDispatchBus(db, {
      historyStore: {
        add: (key, entry) => historyEntries.push({ key, entry }),
      },
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 605,
      issueTitle: "Cancellation notice",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify cancellation surfacing"],
    });

    bus.cancelJob(job.jobId, repoDir);

    const entry = historyEntries.find((h) => h.entry.kind === "action_cancelled");
    assert.ok(entry, "expected a persisted action_cancelled chat entry");
    assert.strictEqual(entry.entry.role, "assistant");
    assert.match(entry.entry.text, /cancelled/);
    assert.strictEqual(bus.getJob(job.jobId)?.status, "cancelled");
  });

  it("keeps a job queued when the runtime preflight reports missing capabilities", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db, {
      sessionManager: {
        getActionsRuntimePreflight: () => ({
          backend: "native",
          capabilities: ["text", "files"],
        }),
      } as any,
    });
    const dispatched = bus.dispatchJob({
      projectId: repoDir,
      issueId: 374,
      issueTitle: "Runtime preflight contract",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Fail before checkout when capabilities are missing"],
    });

    const result = await bus.evaluateQueue(repoDir, repoDir);
    const job = bus.getJob(dispatched.jobId);

    assert.strictEqual(result.allowed, false);
    assert.match(result.reason ?? "", /missing capabilities: commands/);
    assert.strictEqual(job?.status, "queued");
    assert.match(job?.error_message ?? "", /Actions runtime preflight failed/);
    assert.strictEqual(
      spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(),
      "dev",
    );
  });

  it("rejects GitHub Issue dispatches without a complete immutable contract", () => {
    const bus = new LaneDispatchBus(getStateDatabase());

    assert.throws(() => bus.dispatchJob({
      projectId: repoDir,
      issueId: 378,
      issueTitle: "Incomplete Issue",
      jobKind: "github_issue",
    }), /complete issueDescription; GitHub Issue jobs also require non-empty acceptanceCriteria/);
  });

  it("rejects empty or invalid Git evidence", () => {
    assert.match(
      validateGitEvidence({ diff: "", diffStat: "", baseCommit: "invalid", headCommit: "" }) ?? "",
      /git diff returned empty output/,
    );
    assert.match(
      validateGitEvidence({
        diff: "diff --git a/a.ts b/a.ts",
        diffStat: "1 file changed",
        baseCommit: "a".repeat(41),
        headCommit: "b".repeat(40),
      }) ?? "",
      /invalid commit/,
    );
    assert.match(
      validateGitEvidence({
        diff: "diff --git a/a.ts b/a.ts",
        diffStat: "1 file changed",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
      }) ?? "",
      /^$/,
    );
  });

  it("passes the immutable Issue snapshot, committed type context and verification provenance to Reviewer", async () => {
    const db = getStateDatabase();
    let reviewPrompt = "";
    let reviewedHead = "";
    fs.writeFileSync(path.join(repoDir, "types.ts"), "export interface Contract { committedField: string }\n");
    assert.equal(spawnSync("git", ["add", "types.ts"], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "add shared contract"], { cwd: repoDir }).status, 0);
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        fs.writeFileSync(path.join(repoDir, "consumer.ts"), "import type { Contract } from './types.js';\nexport type Input = Contract;\n");
        assert.equal(spawnSync("git", ["add", "consumer.ts"], { cwd: repoDir }).status, 0);
        commitImplementation("snapshot");
        reviewedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
        return { exitCode: 0 };
      },
      reviewerRunner: async (prompt) => {
        reviewPrompt = prompt;
        return JSON.stringify({ status: "PASS", summary: "Snapshot review passed.", defects: [] });
      },
      testCommand: "git log -1 --pretty=%s",
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 366,
      issueTitle: "Reviewer contract",
      issueDescription: "Full immutable Issue description",
      acceptanceCriteria: ["Reviewer starts fresh", "Truncated diff cannot pass"],
      adrs: [{ id: "ADR 0020", title: "Reviewer context", decision: "Use an ephemeral session" }],
    });

    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => bus.getJob(job.jobId)?.status === "completed");

    assert.match(reviewPrompt, /Full immutable Issue description/);
    assert.match(reviewPrompt, /Reviewer starts fresh/);
    assert.match(reviewPrompt, /ADR 0020/);
    assert.match(reviewPrompt, /Exact Diff Range/);
    assert.match(reviewPrompt, /dev\.\.\.HEAD/);
    assert.match(reviewPrompt, /git log -1 --pretty=%s/);
    assert.ok(reviewPrompt.includes(reviewedHead));
    const [context, diff] = reviewPrompt.split("## Git Diff (Untrusted Input Data):");
    assert.match(context!, /Referenced Type Definitions & Interfaces/);
    assert.match(context!, /export interface Contract \{ committedField: string \}/);
    assert.doesNotMatch(diff!, /committedField/);
  });

  it("keeps a follow-up job queued without gate errors while another job runs, even with auto-start on dispatch", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);
    const activeJob = bus.dispatchJob({
      projectId: repoDir,
      issueId: 278,
      issueTitle: "Active task",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the active job"],
      repoPath: repoDir,
    });
    updateActionJobStatus(db, activeJob.jobId, "running");

    spawnSync("git", ["checkout", "-b", "feature-dispatch-boundary"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Dirty dispatch workspace\n");
    const queuedJob = bus.dispatchJob({
      projectId: repoDir,
      issueId: 279,
      issueTitle: "Future task",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the future job"],
      repoPath: repoDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(bus.getJob(queuedJob.jobId)?.status, "queued");
    assert.strictEqual(bus.getJob(queuedJob.jobId)?.error_message, null);
  });

  it("broadcasts a queued status refresh when a job is created", () => {
    const db = getStateDatabase();
    const events: Array<Record<string, unknown>> = [];
    const bus = new LaneDispatchBus(db, {
      broadcastToActionsLane: (payload) => events.push(payload as Record<string, unknown>),
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 280,
      issueTitle: "Queued refresh",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the queued refresh"],
      repoPath: repoDir,
    });

    assert.ok(events.some((event) =>
      event.type === "action_job_updated"
      && event.jobId === job.jobId
      && event.issueId === 280
      && event.status === "queued",
    ));
  });

  it("broadcasts a newly queued job after the previous job failed", () => {
    const db = getStateDatabase();
    const events: Array<Record<string, unknown>> = [];
    const bus = new LaneDispatchBus(db, {
      broadcastToActionsLane: (payload) => events.push(payload as Record<string, unknown>),
    });

    const failedJob = bus.dispatchJob({
      projectId: repoDir,
      issueId: 281,
      issueTitle: "Failed task",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the failure path"],
      repoPath: repoDir,
    });
    updateActionJobStatus(db, failedJob.jobId, "failed");
    events.length = 0;

    const queuedJob = bus.dispatchJob({
      projectId: repoDir,
      issueId: 282,
      issueTitle: "Queued after failure",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify queue progression"],
      repoPath: repoDir,
    });

    assert.ok(events.some((event) =>
      event.type === "action_job_updated"
      && event.jobId === queuedJob.jobId
      && event.issueId === 282
      && event.status === "queued",
    ));
  });

  it("evaluates Three-Point Gate: blocks when previous job is non-terminal", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job1 = bus.dispatchJob({
      projectId: repoDir,
      issueId: 101,
      issueTitle: "Task 1",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify task one"],
    });
    updateActionJobStatus(db, job1.jobId, "running");

    const gate = checkThreePointGate(db, repoDir, repoDir);
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.gateBlocked, "terminal");
  });

  it("evaluates Three-Point Gate: blocks when current branch is not dev", () => {
    const db = getStateDatabase();
    spawnSync("git", ["checkout", "-b", "feature-x"], { cwd: repoDir });

    const gate = checkThreePointGate(db, repoDir, repoDir);
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.gateBlocked, "cleanliness");
    assert.ok(gate.reason?.includes("feature-x"));
  });

  it("evaluates Three-Point Gate: blocks when working tree has uncommitted tracked modifications", () => {
    const db = getStateDatabase();
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Modified tracked file\n");

    const gate = checkThreePointGate(db, repoDir, repoDir);
    assert.strictEqual(gate.allowed, false);
    assert.strictEqual(gate.gateBlocked, "cleanliness");
    assert.ok(gate.reason?.includes("uncommitted tracked changes"));
  });

  it("evaluates Three-Point Gate and dequeues task when all gates pass", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 202,
      issueTitle: "Task 202",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify task 202"],
    });

    const res = await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.dequeuedJobId, job.jobId);

    const activeJob = bus.getJob(job.jobId);
    // What runs after the gate depends on the harness: with no developer runner
    // the job either blocks on the missing session manager or parks in running.
    // Both leave the queue, which is what this gate is responsible for.
    assert.notStrictEqual(activeJob?.status, "queued");

    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "codex/issue-202");
  });

  it("records the base commit the feature branch was cut from", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 204,
      issueTitle: "Task 204",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify task 204"],
    });

    await bus.evaluateQueue(repoDir, repoDir);

    const branchTip = spawnSync("git", ["rev-parse", "codex/issue-204"], { cwd: repoDir, encoding: "utf8" })
      .stdout.trim();
    assert.strictEqual(bus.getJob(job.jobId)?.base_sha, branchTip);
  });

  it("keeps the recorded base commit when a rework pass reuses the branch", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 205,
      issueTitle: "Task 205",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify task 205"],
    });

    await bus.evaluateQueue(repoDir, repoDir);
    const anchor = bus.getJob(job.jobId)?.base_sha;
    assert.ok(anchor, "expected the first pass to record a base commit");

    // dev advances and the same branch is checked out again, as a rework does.
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\nmore\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "dev moved on"], { cwd: repoDir });
    spawnSync("git", ["checkout", "codex/issue-205"], { cwd: repoDir });
    await bus.evaluateQueue(repoDir, repoDir);

    assert.strictEqual(bus.getJob(job.jobId)?.base_sha, anchor);
  });

  it("handles reviewer PASS and completes the automatic merge", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db, {
      mergePipeline: () => ({ success: true }),
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 303,
      issueTitle: "Task 303",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify task 303"],
    });

    const res = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "PASS",
      reviewSummary: "LGTM",
    });

    assert.strictEqual(res.status, "completed");
    const updated = bus.getJob(job.jobId);
    assert.strictEqual(updated?.status, "completed");
    assert.strictEqual(updated?.pr_number, null);
    assert.ok(updated?.current_step?.includes("PR squash merged"));
  });

  it("merges local branch via fast-forward fallback when no PR number exists", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 505,
      issueTitle: "Offline task",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify offline behavior"],
    });

    // Dequeue job and checkout branch
    await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(), "codex/issue-505");

    // Make a commit on the feature branch
    fs.writeFileSync(path.join(repoDir, "feature.txt"), "offline work");
    spawnSync("git", ["add", "feature.txt"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "feature 505"], { cwd: repoDir });

    // Pass review
    bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "PASS",
      reviewSummary: "All good",
    });

    assert.strictEqual(bus.getJob(job.jobId)?.status, "completed");

    // Verify dev now has the commit and feature branch is cleaned up
    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "dev");
    assert.ok(fs.existsSync(path.join(repoDir, "feature.txt")));
  });

  it("handles reviewer REJECT with rework bounds (max 3)", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 404,
      issueTitle: "Task 404",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify task 404"],
    });

    // Attempt 1 -> running (rework)
    const r1 = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Defect 1",
      reworkCount: 0,
    });
    assert.strictEqual(r1.status, "running");
    assert.strictEqual(bus.getJob(job.jobId)?.rework_count, 1);

    // Attempt 2 -> running (rework)
    const r2 = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Defect 2",
      reworkCount: 1,
    });
    assert.strictEqual(r2.status, "running");
    assert.strictEqual(bus.getJob(job.jobId)?.rework_count, 2);

    // Attempt 3 -> blocked (limit reached, differing failures each time)
    const r3 = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Defect 3",
      reworkCount: 2,
    });
    assert.strictEqual(r3.status, "blocked");

    const blocked = bus.getJob(job.jobId);
    assert.strictEqual(blocked?.rework_count, 3);
    assert.strictEqual(blocked?.error_message, "Reviewer rejection failed: Defect 3");
    assert.strictEqual(blocked?.current_step, "Human attention required after 3 rework attempts.");

    const attempts = JSON.parse(blocked?.attempts_json ?? "[]") as Array<Record<string, unknown>>;
    assert.strictEqual(attempts.length, 3);
    assert.deepStrictEqual(attempts.map((entry) => entry.attempt), [1, 2, 3]);
    assert.ok(attempts.every((entry) => entry.stage === "Reviewer rejection"));
    assert.ok(attempts.every((entry) => typeof entry.ts === "number"));
    assert.match(String(attempts[0]?.failure), /Defect 1/);
    assert.match(String(attempts[1]?.failure), /Defect 2/);
    assert.match(String(attempts[2]?.failure), /Defect 3/);
  });

  it("blocks a rework whose failure repeats the immediately preceding one", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 4041,
      issueTitle: "Repeated reviewer rejection",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify repeated failure short circuit"],
    });

    const first = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Identical defect",
      reworkCount: 0,
    });
    assert.strictEqual(first.status, "running");

    const second = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Identical defect",
      reworkCount: 1,
    });
    assert.strictEqual(second.status, "blocked");

    const blocked = bus.getJob(job.jobId);
    assert.strictEqual(blocked?.rework_count, 2);
    assert.match(blocked?.current_step ?? "", /retry was cut short/);
    assert.strictEqual(JSON.parse(blocked?.attempts_json ?? "[]").length, 2);
  });

  it("carries every recorded attempt into the next Developer prompt", async () => {
    const db = getStateDatabase();
    const prompts: string[] = [];
    let developerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async (_job, _repoPath, reworkFeedback) => {
        developerCalls += 1;
        if (reworkFeedback) prompts.push(reworkFeedback);
        return { exitCode: 1, error: `developer failure ${developerCalls}` };
      },
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "ok", defects: [] }),
      testCommand: "git status",
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 4042,
      issueTitle: "Attempt history propagation",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify attempt history reaches the prompt"],
    });

    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => prompts.length === 2, 8000);

    // The prompt for the third attempt must carry attempts 1 and 2.
    assert.match(prompts[0] ?? "", /Attempt 1 failed during Developer execution/);
    assert.match(prompts[0] ?? "", /developer failure 1/);
    assert.match(prompts[1] ?? "", /Attempt 1 failed during Developer execution/);
    assert.match(prompts[1] ?? "", /developer failure 1/);
    assert.match(prompts[1] ?? "", /Attempt 2 failed during Developer execution/);
    assert.match(prompts[1] ?? "", /developer failure 2/);

    await waitFor(() => bus.getJob(job.jobId)?.status === "blocked", 8000);
    const blocked = bus.getJob(job.jobId);
    assert.strictEqual(blocked?.rework_count, 3);
    assert.strictEqual(JSON.parse(blocked?.attempts_json ?? "[]").length, 3);
  });

  it("records every attempt failure in the lane while the job is still retrying", () => {
    const db = getStateDatabase();
    const historyEntries: any[] = [];
    const bus = new LaneDispatchBus(db, {
      historyStore: {
        add: (key, entry) => historyEntries.push({ key, entry }),
      },
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 4043,
      issueTitle: "Attempt failure surfacing",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify attempt failures reach the lane"],
    });

    // The first rejection returns to running rather than blocking, and the lane
    // must already carry the reason the next Developer pass exists.
    const first = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Defect 1",
      reworkCount: 0,
    });
    assert.strictEqual(first.status, "running");

    const attemptEntries = historyEntries.filter((entry) => entry.entry.kind === "action_attempt_failed");
    assert.strictEqual(attemptEntries.length, 1);
    assert.strictEqual(attemptEntries[0]?.entry.role, "assistant");
    assert.strictEqual(
      attemptEntries[0]?.entry.text,
      "Attempt 1 failed during Reviewer rejection: Reviewer rejection failed: Defect 1",
    );
    assert.strictEqual(JSON.parse(bus.getJob(job.jobId)?.attempts_json ?? "[]").length, 1);
  });

  it("routes developer failure to bounded rework and advances after automatic merge", async () => {
    const db = getStateDatabase();
    let developerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        developerCalls += 1;
        if (developerCalls === 1) {
          return { exitCode: 1, error: "simulated developer failure" };
        }
        commitImplementation("developer-recovery");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "Recovered implementation passed review.",
        defects: [],
      }),
      testCommand: "git status",
    });
    const failedJob = bus.dispatchJob({
      projectId: repoDir,
      issueId: 405,
      issueTitle: "Recoverable developer failure",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify bounded rework"],
    });
    const queuedJob = bus.dispatchJob({
      projectId: repoDir,
      issueId: 406,
      issueTitle: "Must remain queued",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify queue state"],
    });

    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => developerCalls === 1);
    assert.strictEqual(bus.getJob(failedJob.jobId)?.status, "running");
    assert.strictEqual(bus.getJob(failedJob.jobId)?.rework_count, 1);
    assert.strictEqual(bus.getJob(failedJob.jobId)?.branch, "codex/issue-405");

    const blocked = await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.gateBlocked, "terminal");
    assert.strictEqual(bus.getJob(queuedJob.jobId)?.status, "queued");

    await waitFor(() => bus.getJob(failedJob.jobId)?.status === "completed"
      && bus.getJob(queuedJob.jobId)?.status === "completed", 10000);
    assert.strictEqual(developerCalls, 3);
    assert.strictEqual(bus.getJob(queuedJob.jobId)?.status, "completed");
  });

  it("routes verification failure to rework without invoking reviewer", async () => {
    const db = getStateDatabase();
    let reviewerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        commitImplementation("verification-failure");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => {
        reviewerCalls += 1;
        return JSON.stringify({ status: "PASS", summary: "Should not run", defects: [] });
      },
      testCommand: "node -e process.exit(1)",
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 407,
      issueTitle: "Verification recovery",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify verification recovery"],
    });
    await bus.evaluateQueue(repoDir, repoDir);

    await waitFor(() => bus.getJob(job.jobId)?.status === "blocked");
    assert.strictEqual(bus.getJob(job.jobId)?.rework_count, 2);
    assert.strictEqual(reviewerCalls, 0);
    assert.match(bus.getJob(job.jobId)?.error_message ?? "", /Verification/);
  });

  it("retries a failing pull request creation on the CLI instead of re-running the Developer", async () => {
    const db = getStateDatabase();
    let prCalls = 0;
    let developerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        developerCalls += 1;
        commitImplementation("pr-recovery");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "PR recovery passed review.",
        defects: [],
      }),
      testCommand: "git status",
      hasRemoteOrigin: () => true,
      pullRequestCreator: () => {
        prCalls += 1;
        return prCalls === 1
          ? { prNumber: null, prUrl: null, error: "simulated PR failure" }
          : { prNumber: 345, prUrl: "https://example.test/pull/345" };
      },
      mergePipeline: () => ({ success: true }),
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 408,
      issueTitle: "PR creation recovery",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify PR recovery"],
    });
    spawnSync("git", ["checkout", "-b", job.branch!], { cwd: repoDir });

    const firstResult = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "PASS",
      reviewSummary: "Ready",
    });
    await waitFor(() => bus.getJob(job.jobId)?.status === "completed");

    const recovered = bus.getJob(job.jobId);
    assert.strictEqual(firstResult.status, "completed");
    assert.strictEqual(prCalls, 2);
    // The retry happened on the CLI call, so no rework budget was spent and the
    // Developer was never asked to run again.
    assert.strictEqual(recovered?.rework_count, 0);
    assert.strictEqual(developerCalls, 0);
    assert.strictEqual(recovered?.branch, "codex/issue-408");
    assert.strictEqual(recovered?.pr_number, 345);
  });

  it("blocks without spending rework or re-running the Developer when PR creation keeps failing", async () => {
    const db = getStateDatabase();
    let prCalls = 0;
    let developerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        developerCalls += 1;
        commitImplementation("pr-blocked");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "PR creation still failing.",
        defects: [],
      }),
      testCommand: "git status",
      hasRemoteOrigin: () => true,
      pullRequestCreator: () => {
        prCalls += 1;
        return { prNumber: null, prUrl: null, error: "simulated PR failure" };
      },
      mergePipeline: () => ({ success: true }),
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 409,
      issueTitle: "PR creation blocked",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify PR creation blocking"],
    });
    spawnSync("git", ["checkout", "-b", job.branch!], { cwd: repoDir });

    const result = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "PASS",
      reviewSummary: "Ready",
    });

    assert.strictEqual(result.status, "blocked");
    const blocked = bus.getJob(job.jobId);
    assert.strictEqual(blocked?.status, "blocked");
    assert.strictEqual(blocked?.rework_count, 0);
    assert.strictEqual(blocked?.attempts_json, "[]");
    assert.strictEqual(prCalls, 3);
    assert.strictEqual(developerCalls, 0);
    assert.match(blocked?.error_message ?? "", /PR creation failed: simulated PR failure \(tried 3 times\)/);
  });

  it("recovers from merge failure and only then advances the queue", async () => {
    const db = getStateDatabase();
    let mergeCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        commitImplementation("merge-recovery");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "Merge recovery passed review.",
        defects: [],
      }),
      testCommand: "git status",
      mergePipeline: () => {
        mergeCalls += 1;
        return mergeCalls === 1
          ? { success: false, error: "simulated merge failure" }
          : { success: true };
      },
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 409,
      issueTitle: "Merge recovery",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify merge recovery"],
    });
    spawnSync("git", ["checkout", "-b", job.branch!], { cwd: repoDir });
    updateActionJobStatus(db, job.jobId, "waiting_merge", { pr_number: null });

    const firstMerge = bus.executeDeterministicMerge(job.jobId, repoDir);
    assert.strictEqual(firstMerge.success, false);
    await waitFor(() => bus.getJob(job.jobId)?.status === "running" && bus.getJob(job.jobId)?.rework_count === 1);

    const secondMerge = bus.executeDeterministicMerge(job.jobId, repoDir);
    assert.strictEqual(secondMerge.success, true);
    assert.strictEqual(bus.getJob(job.jobId)?.status, "completed");
    assert.strictEqual(mergeCalls, 2);
  });

  it("cancels a job when requested", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueTitle: "To Cancel",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify cancellation"],
    });

    bus.cancelJob(job.jobId, repoDir);
    const updated = bus.getJob(job.jobId);
    assert.strictEqual(updated?.status, "cancelled");
    assert.strictEqual(spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(), "dev");
  });

  it("runs full automated job cycle through verification and review", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        commitImplementation("automated-cycle");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "Automated cycle passed review.",
        defects: [],
      }),
      testCommand: "git status",
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 606,
      issueTitle: "Automated cycle",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify the automated cycle"],
    });

    // Start job
    await bus.evaluateQueue(repoDir, repoDir);

    await waitFor(() => bus.getJob(job.jobId)?.status === "completed");

    const finishedJob = bus.getJob(job.jobId);
    assert.strictEqual(finishedJob?.status, "completed");
    assert.ok(finishedJob?.review_verdicts_json.includes("PASS"));
  });

  it("invokes developer runner on dequeue and triggers review upon exit 0", async () => {
    const db = getStateDatabase();
    let devRan = false;

    const bus = new LaneDispatchBus(db, {
      developerRunner: async (job, rPath, _reworkFeedback, executionMode) => {
        devRan = true;
        assert.strictEqual(job.issue_id, 707);
        assert.strictEqual(rPath, repoDir);
        assert.strictEqual(executionMode, "automated_action");
        // Simulate developer making a commit on feature branch
        fs.writeFileSync(path.join(repoDir, "feature707.txt"), "done");
        spawnSync("git", ["add", "feature707.txt"], { cwd: repoDir });
        spawnSync("git", ["commit", "-m", "feature 707"], { cwd: repoDir });
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "Developer runner output passed review.",
        defects: [],
      }),
      testCommand: "git status",
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 707,
      issueTitle: "Test dev runner",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify developer execution"],
    });
    assert.ok(job.jobId);

    await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(devRan, true);
    await waitFor(() => bus.getJob(job.jobId)?.status === "completed");
  });

  it("routes reviewer rejection defect feedback back to developer for rework", async () => {
    const db = getStateDatabase();
    let devCalls = 0;
    let receivedFeedback: string | undefined;

    const bus = new LaneDispatchBus(db, {
      developerRunner: async (job, rPath, reworkFeedback, executionMode) => {
        devCalls++;
        receivedFeedback = reworkFeedback;
        assert.strictEqual(executionMode, "automated_action");
        commitImplementation(`reviewer-rework-${devCalls}`);
        return { exitCode: 0 };
      },
      reviewerRunner: async () => {
        if (devCalls === 1) {
          return JSON.stringify({
            status: "REJECT",
            summary: "Needs fix",
            defects: [{ file: "feature.ts", line: 10, severity: "blocker", description: "Missing null check" }],
          });
        }
        return JSON.stringify({
          status: "PASS",
          summary: "All good",
          defects: [],
        });
      },
      testCommand: "git status",
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 808,
      issueTitle: "Test rework runner",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify rework execution"],
    });

    await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(devCalls, 1);

    // Run job cycle to trigger reviewer
    await bus.runJobCycle(job.jobId, repoDir, {
      testCommand: "git status",
    });

    const rejectedJob = bus.getJob(job.jobId);
    assert.strictEqual(rejectedJob?.status, "running");
    assert.ok(rejectedJob?.current_step?.includes("rework"));
    assert.ok(rejectedJob?.review_verdicts_json.includes("REJECT"));
    await waitFor(() => devCalls === 2 && bus.getJob(job.jobId)?.status === "completed");
    void receivedFeedback;
  });

  it("submits prompt to Actions sessionManager, streams events, and records history upon dequeue", async () => {
    const db = getStateDatabase();
    const streamedEvents: any[] = [];
    const historyEntries: any[] = [];
    const interruptControllers = new Map<string, AbortController>();

    let instructionsSet = "";
    let turnPrompt = "";

    const mockOrchestrator = {
      getActiveAgentId: () => "codex",
      getThreadId: () => "thread-test-123",
      onEvent: (handler: (ev: any) => void) => {
        handler({
          phase: "analysis",
          title: "Analyzing repository",
          delta: "Analyzing files...",
          liveStep: true,
          timestamp: Date.now(),
        });
        handler({
          phase: "command",
          title: "Running check",
          delta: "git status",
          timestamp: Date.now(),
        });
        handler({
          phase: "command",
          title: "Command completed",
          timestamp: Date.now(),
          raw: {
            type: "item.completed",
            item: {
              type: "command_execution",
              id: "cmd-obs-1",
              command: "git status",
              status: "completed",
              exitCode: 0,
              aggregated_output: "working tree clean",
            },
          },
        });
        handler({
          phase: "editing",
          title: "Applied file change",
          timestamp: Date.now(),
          raw: {
            type: "item.completed",
            item: {
              type: "file_change",
              id: "file-change-1",
              changes: [{ kind: "modify", path: "server/example.ts" }],
            },
          },
        });
        return () => {};
      },
      setDeveloperInstructions: (inst: string) => {
        instructionsSet = inst;
      },
      invokeAgent: async (_agentId: string, input: any) => {
        turnPrompt = typeof input === "string" ? input : input[0]?.text || "";
        commitImplementation("session-manager");
        return { response: "Implemented changes successfully", usage: { input_tokens: 10, output_tokens: 20 } };
      },
      send: async (input: any) => {
        assert.ok(typeof input === "string" || Array.isArray(input));
        return {
          response: JSON.stringify({ status: "PASS", summary: "Session review passed.", defects: [] }),
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    };

    const mockSessionManager = { getOrCreate: () => mockOrchestrator };

    const bus = new LaneDispatchBus(db, {
      sessionManager: mockSessionManager as any,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "Session review passed.", defects: [] }),
      historyStore: {
        add: (key, entry) => {
          historyEntries.push({ key, entry });
        },
      },
      broadcastToActionsLane: (payload, targetKey, pid) => {
        streamedEvents.push({ payload, targetKey, pid });
      },
      interruptControllers,
      testCommand: "git status",
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 909,
      issueTitle: "Test session manager streaming",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify streaming"],
    });

    await bus.evaluateQueue(repoDir, repoDir);

    // Wait for async execution turn to complete
    for (let i = 0; i < 50; i++) {
      if (streamedEvents.some((e) => e.payload.type === "assistant_done" || e.payload.type === "result")) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify session turn executed
    assert.ok(turnPrompt.includes("Issue #909"));
    assert.match(turnPrompt, /already authorized/i);
    assert.match(turnPrompt, /Do not ask for another goal confirmation/i);
    assert.ok(instructionsSet.length > 0);

    // Verify event streaming to Actions lane
    assert.ok(streamedEvents.some((e) => (e.payload.type === "message" || e.payload.type === "user") && (e.payload.text?.includes("Issue #909") || e.payload.content?.includes("Issue #909"))));
    assert.ok(streamedEvents.some((e) =>
      e.payload.type === "command"
      && e.payload.command === "Running check"
      && e.payload.output === "git status"
      && e.payload.status === "running"
      && e.payload.jobId === job.jobId,
    ));
    assert.ok(streamedEvents.some((e) => (e.payload.type === "assistant_done" || e.payload.type === "result")));
    assert.ok(streamedEvents.some((e) => e.payload.type === "action_job_updated" && e.payload.status === "running"));
    assert.ok(streamedEvents.some((e) => e.payload.type === "file_change" && e.payload.status === "completed"));

    // Verify history recording
    assert.ok(historyEntries.some((h) => h.entry.role === "user"));
    assert.ok(historyEntries.some((h) => h.entry.role === "assistant"));
    assert.ok(historyEntries.some((h) =>
      h.entry.kind === "action_execute"
      && h.entry.text.includes("$ git status")
      && h.entry.text.includes("working tree clean"),
    ));
    assert.ok(historyEntries.some((h) =>
      h.entry.kind === "file_change"
      && h.entry.text.includes("server/example.ts"),
    ));

    // Wait for full cycle (verification + reviewer) to complete
    for (let i = 0; i < 50; i++) {
      const current = bus.getJob(job.jobId);
      if (current?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify verification and reviewer events streamed to Actions lane
    assert.ok(streamedEvents.some((e) => (e.payload.type === "command" || e.payload.type === "command_snapshot") && (e.payload.command === "git status" || e.payload.command?.command === "git status")));
    assert.ok(streamedEvents.some((e) => (e.payload.type === "message" || e.payload.type === "delta") && (e.payload.text?.includes("Code Review") || e.payload.delta?.includes("Code Review"))));
    assert.equal(streamedEvents.some((e) => e.payload.type === "step"), false);

    // Verify history recording for review verdict
    assert.ok(historyEntries.some((h) => h.entry.kind === "review_verdict"));
    assert.notStrictEqual(bus.getJob(job.jobId)?.steps_json, "[]");
    assert.strictEqual(interruptControllers.size, 0);
  });

  it("enforces the diff gate before either Reviewer transport", async () => {
    const db = getStateDatabase();
    const diff = ["diff --git a/large.ts b/large.ts", ...Array.from({ length: 1499 }, (_, i) => `+ line ${i}`)].join("\n");
    const response = JSON.stringify({ status: "PASS", summary: "Complete evidence", defects: [] });
    for (const useNative of [false, true]) {
      let calls = 0;
      const review = async (prompt: string) => { calls++; assert.ok(prompt.includes(diff)); return response; };
      const bus = new LaneDispatchBus(db, useNative ? reviewerOptions(async (request) => ({ text: await review(request.messages[1]!.content!), toolCalls: [], usage: null })) : { reviewerRunner: review });
      const payload = { ...reviewerPayload(), diff };
      assert.equal((await bus.executeReviewer(payload, repoDir)).status, "PASS");
      assert.equal((await bus.executeReviewer({ ...payload, diff: `${diff}\n+ overflow` }, repoDir)).status, "REJECT");
      assert.equal(calls, 1);
    }
  });

  it("uses database Reviewer settings without opening a general agent session or broadcasting protocol data", async () => {
    const db = getStateDatabase();
    const profile = getDefaultRoleProfile(db, "reviewer")!;
    db.prepare("UPDATE role_profiles SET model_id = ?, system_prompt = ?, reasoning_effort = ? WHERE id = ?")
      .run("review-only-model", "Custom review instructions", "low", profile.id);
    let calls = 0;
    const broadcasts: unknown[] = [];
    const bus = new LaneDispatchBus(db, {
      ...reviewerOptions(async (request) => {
        calls++;
        assert.equal(request.model, "review-only-model");
        assert.equal(request.options?.reasoningEffort, "low");
        assert.equal(request.messages[0]?.content, "Custom review instructions");
        assert.deepEqual(request.tools.map((tool) => tool.function.name), ["read_file_range", "search_code", "list_dir"]);
        assert.equal(request.messages.length, 2);
        return { text: JSON.stringify({ status: "PASS", summary: "Approved", defects: [] }), toolCalls: [], usage: null };
      }),
      sessionManager: { getOrCreate() { throw new Error("general agent session forbidden"); } } as any,
      broadcastToActionsLane: (event) => broadcasts.push(event),
    });
    for (let i = 0; i < 2; i++) assert.equal((await bus.executeReviewer(reviewerPayload(), repoDir)).status, "PASS");
    assert.equal(calls, 2);
    assert.deepEqual(broadcasts, []);
    db.prepare("UPDATE role_profiles SET is_enabled = 0 WHERE id = ?").run(profile.id);
    await assert.rejects(bus.executeReviewer(reviewerPayload(), repoDir), /enabled Reviewer role profile/);
    assert.equal(calls, 2);
  });

  it("aborts pending Reviewer requests and releases in-memory context on cancellation", async () => {
    const entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    let active = 0;
    let messages: unknown[] = [];
    const bus = new LaneDispatchBus(getStateDatabase(), reviewerOptions(async (request) => {
      active++;
      messages = request.messages;
      entered.resolve();
      try { return await new Promise<never>((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true })); }
      finally { active--; }
    }));
    const pending = bus.executeReviewer(reviewerPayload(), repoDir, undefined, undefined, undefined, undefined, abort.signal);
    await entered.promise;
    abort.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    assert.equal(active, 0);
    assert.equal(messages.length, 0);
  });

  it("bounds Reviewer requests with a deadline and releases their context", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = Promise.withResolvers<void>();
    let active = 0;
    const bus = new LaneDispatchBus(getStateDatabase(), {
      reviewerTimeoutMs: 1000,
      ...reviewerOptions(async (request) => {
        active++;
        entered.resolve();
        try { return await new Promise<never>((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true })); }
        finally { active--; }
      }),
    });
    const pending = bus.executeReviewer(reviewerPayload(), repoDir);
    await entered.promise;
    context.mock.timers.tick(1000);
    await assert.rejects(pending, /timed out/);
    assert.equal(active, 0);
  });

  it("blocks Reviewer transport failures without spending Developer rework", async () => {
    const db = getStateDatabase();
    let developerCalls = 0;
    let reviewerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        developerCalls++;
        commitImplementation(`reviewer-failure-${developerCalls}`);
        return { exitCode: 0 };
      },
      ...reviewerOptions(async () => { reviewerCalls++; throw new Error("detached reviewer unavailable"); }),
      testCommand: "git status",
    });
    const job = bus.dispatchJob({ projectId: repoDir, issueId: 351, issueTitle: "Reviewer failure recovery", issueDescription: "Complete issue description", acceptanceCriteria: ["Verify reviewer recovery"] });
    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => bus.getJob(job.jobId)?.status === "blocked");
    assert.equal(bus.getJob(job.jobId)?.rework_count, 0);
    assert.equal(bus.getJob(job.jobId)?.attempts_json, "[]");
    assert.equal(bus.getJob(job.jobId)?.review_verdicts_json, "[]");
    assert.equal(developerCalls, 1);
    assert.equal(reviewerCalls, 1);
    assert.match(bus.getJob(job.jobId)?.error_message ?? "", /Reviewer execution failed/);
    assert.match(bus.getJob(job.jobId)?.current_step ?? "", /no rework attempt was spent/);
  });

  it("blocks malformed Reviewer verdicts without fabricating a code review or spending rework", async () => {
    const db = getStateDatabase();
    let developerCalls = 0;
    let reviewerCalls = 0;
    const historyKinds: Array<string | undefined> = [];
    const malformedBus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        developerCalls++;
        commitImplementation("malformed-reviewer");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => { reviewerCalls++; return "not-json"; },
      historyStore: { add: (_key, entry) => { historyKinds.push(entry.kind); } },
      testCommand: "git status",
    });
    const malformedJob = malformedBus.dispatchJob({
      projectId: repoDir,
      issueId: 3511,
      issueTitle: "Malformed reviewer output",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify malformed verdict handling"],
    });
    await malformedBus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => malformedBus.getJob(malformedJob.jobId)?.status === "blocked");
    const blocked = malformedBus.getJob(malformedJob.jobId)!;
    assert.equal(developerCalls, 1);
    assert.equal(reviewerCalls, 1);
    assert.equal(blocked.rework_count, 0);
    assert.equal(blocked.attempts_json, "[]");
    assert.equal(blocked.review_verdicts_json, "[]");
    assert.match(blocked.error_message ?? "", /invalid verdict JSON/);
    assert.doesNotMatch(blocked.error_message ?? "", /not-json/);
    assert.ok(historyKinds.includes("action_blocked"));
    assert.ok(!historyKinds.includes("review_verdict"));
    assert.ok(!historyKinds.includes("action_rework"));
  });

  it("completes a native Reviewer batch larger than four calls without Developer rework", async () => {
    let developerCalls = 0;
    let reviewerCalls = 0;
    const toolCalls = Array.from({ length: 6 }, (_, i) => ({
      id: `read-${i}`, type: "function" as const,
      function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
    }));
    const bus = new LaneDispatchBus(getStateDatabase(), {
      developerRunner: async () => {
        developerCalls++;
        commitImplementation("reviewer-batch");
        return { exitCode: 0 };
      },
      ...reviewerOptions(async (request) => {
        reviewerCalls++;
        if (reviewerCalls === 1) return { text: "", toolCalls, finishReason: "tool_calls", usage: null };
        const results = request.messages.filter((message) => message.role === "tool");
        assert.deepEqual(results.map((message) => message.tool_call_id), toolCalls.map((call) => call.id));
        assert.ok(results.every((message) => String(message.content).includes("README.md")));
        return { text: JSON.stringify({ status: "PASS", summary: "Inspected all requested evidence", defects: [] }), toolCalls: [], finishReason: "stop", usage: null };
      }),
      mergePipeline: () => ({ success: true }),
      testCommand: "git status",
    });
    const job = bus.dispatchJob({ projectId: repoDir, issueId: 3512, issueTitle: "Reviewer batch regression", issueDescription: "Inspect six independent paths", acceptanceCriteria: ["Complete all six calls"] });
    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => bus.getJob(job.jobId)?.status === "completed");
    const completed = bus.getJob(job.jobId)!;
    assert.equal(developerCalls, 1);
    assert.equal(reviewerCalls, 2);
    assert.equal(completed.rework_count, 0);
    assert.equal(completed.attempts_json, "[]");
    assert.equal(JSON.parse(completed.review_verdicts_json)[0].status, "PASS");
  });

  it("blocks a truncated native Reviewer response even when its text is valid PASS JSON", async () => {
    let developerCalls = 0;
    const bus = new LaneDispatchBus(getStateDatabase(), {
      developerRunner: async () => {
        developerCalls++;
        commitImplementation("truncated-reviewer");
        return { exitCode: 0 };
      },
      ...reviewerOptions(async () => ({
        text: JSON.stringify({ status: "PASS", summary: "incomplete-response-marker", defects: [] }),
        toolCalls: [], finishReason: "length", usage: null,
      })),
      testCommand: "git status",
    });
    const job = bus.dispatchJob({ projectId: repoDir, issueId: 3513, issueTitle: "Truncated reviewer output", issueDescription: "Do not accept truncated review output", acceptanceCriteria: ["Preserve rework budget"] });
    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => bus.getJob(job.jobId)?.status === "blocked");
    const blocked = bus.getJob(job.jobId)!;
    assert.equal(developerCalls, 1);
    assert.equal(blocked.rework_count, 0);
    assert.equal(blocked.attempts_json, "[]");
    assert.equal(blocked.review_verdicts_json, "[]");
    assert.match(blocked.error_message ?? "", /finish_reason=length/);
    assert.doesNotMatch(blocked.error_message ?? "", /incomplete-response-marker/);
  });

  it("blocks confirmation-only Developer turns that produce no committed diff", async () => {
    const db = getStateDatabase();
    let developerCalls = 0;
    let reviewerCalls = 0;
    const bus = new LaneDispatchBus(db, {
      developerRunner: async (_job, _repoPath, _feedback, executionMode) => {
        developerCalls += 1;
        assert.strictEqual(executionMode, "automated_action");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => {
        reviewerCalls += 1;
        return JSON.stringify({ status: "PASS", summary: "Should not run", defects: [] });
      },
      testCommand: "git status",
    });
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 353,
      issueTitle: "Confirmation-only Developer turn",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify no-diff handling"],
    });

    await bus.evaluateQueue(repoDir, repoDir);
    await waitFor(() => bus.getJob(job.jobId)?.status === "blocked");
    // The missing diff repeats, so the retry is cut short after the second attempt.
    assert.strictEqual(developerCalls, 2);
    assert.strictEqual(reviewerCalls, 0);
    assert.strictEqual(bus.getJob(job.jobId)?.rework_count, 2);
    assert.match(bus.getJob(job.jobId)?.error_message ?? "", /Developer produced no implementation diff/);
  });

  it("uses project-specific chat_session_id from web_projects for history and action broadcasts", async () => {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const now = Date.now();
    const customChatSessionId = "custom-chat-session-uuid-777";
    const canonicalProjectId = repoDir;
    db.prepare(
      "INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("admin", "admin@test", "hash", now, now);
    db.prepare(
      "INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("admin", canonicalProjectId, repoDir, "Custom Session Project", customChatSessionId, 0, now, now);

    const historyEntries: any[] = [];
    const bus = new LaneDispatchBus(db, {
      developerRunner: async () => {
        commitImplementation("custom-lane");
        return { exitCode: 0 };
      },
      reviewerRunner: async () => JSON.stringify({
        status: "PASS",
        summary: "Custom lane passed review.",
        defects: [],
      }),
      historyStore: {
        add: (key, entry) => {
          historyEntries.push({ key, entry });
        },
      },
      testCommand: "git status",
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 994,
      issueTitle: "Test custom chatSessionId",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify custom lane routing"],
    });
    await bus.evaluateQueue(repoDir, repoDir);

    await bus.runJobCycle(job.jobId, repoDir, {
      testCommand: "git status",
    });

    assert.ok(historyEntries.length > 0);
    assert.ok(historyEntries.some((h) => h.key.includes(customChatSessionId)));
    assert.ok(!historyEntries.some((h) => h.key.includes("::worker")));
  });

  it("routes a non-admin user's job events only to that user's project lane", async () => {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const now = Date.now();
    const userId = "user-uuid-352";
    const otherUserId = "other-user-uuid-352";
    const customChatSessionId = "user-project-lane-352";
    const insertUser = db.prepare(
      "INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertUser.run(userId, `${userId}@test`, "hash", now, now);
    insertUser.run(otherUserId, `${otherUserId}@test`, "hash", now, now);
    const insertProject = db.prepare(
      "INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertProject.run(userId, repoDir, repoDir, "User Project", customChatSessionId, 0, now, now);
    insertProject.run(otherUserId, repoDir, repoDir, "Other User Project", "other-user-lane-352", 1, now, now);

    const historyEntries: Array<{ key: string; entry: { kind?: string } }> = [];
    const broadcasts: Array<{ payload: Record<string, unknown>; targetHistoryKey?: string }> = [];
    const bus = new LaneDispatchBus(db, {
      historyStore: {
        add: (key, entry) => historyEntries.push({ key, entry }),
      },
      broadcastToActionsLane: (payload, targetHistoryKey) => broadcasts.push({
        payload: payload as Record<string, unknown>,
        targetHistoryKey,
      }),
    });

    const dispatched = bus.dispatchJob({
      projectId: repoDir,
      repoPath: repoDir,
      issueId: 995,
      issueTitle: "Authenticated lane routing",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify authenticated routing"],
      authUserId: userId,
    });
    updateActionJobStatus(db, dispatched.jobId, "running");
    await bus.runJobCycle(dispatched.jobId, repoDir, {
      testCommand: "git status",
      callReviewerModel: async () => JSON.stringify({
        status: "PASS",
        summary: "The authenticated project lane is isolated.",
        defects: [],
      }),
    });

    const stored = bus.getJob(dispatched.jobId);
    assert.strictEqual(stored?.auth_user_id, userId);
    assert.strictEqual(stored?.chat_session_id, customChatSessionId);
    assert.ok(historyEntries.length > 0);
    assert.ok(historyEntries.every(({ key }) => key.startsWith(`${userId}::`) && key.endsWith(`::${customChatSessionId}`)));
    assert.ok(broadcasts.length > 0);
    assert.ok(broadcasts.every(({ targetHistoryKey }) =>
      typeof targetHistoryKey === "string" &&
      targetHistoryKey.startsWith(`${userId}::`) &&
      targetHistoryKey.endsWith(`::${customChatSessionId}`),
    ));
    assert.strictEqual(bus.getJobs(repoDir, repoDir, userId).length, 1);
    assert.strictEqual(bus.getJobs(repoDir, repoDir, otherUserId).length, 0);
  });

  it("manually starts queued job via POST /api/actions/queue/start", async () => {
    const db = getStateDatabase();
    addWebProjectMapping(db, "project-hash");
    const bus = new LaneDispatchBus(db, {
      testCommand: "git status",
    });
    setBusInstance(bus);

    const job = bus.dispatchJob({
      projectId: "project-hash",
      issueId: 991,
      issueTitle: "Manual queue start test",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify manual queue start"],
    });

    const activeBefore = bus.getJob(job.jobId);
    assert.strictEqual(activeBefore?.status, "queued");

    const reqPayload = Buffer.from(JSON.stringify({ projectId: "project-hash", repoPath: repoDir }), "utf8");
    const fakeReq: any = {
      method: "POST",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield reqPayload;
      },
    };

    let responseBody = "";
    let statusCode = 200;
    const fakeRes: any = {
      writeHead(code: number) { statusCode = code; },
      setHeader() {},
      end(data: string) { responseBody = data; },
    };

    const handled = await handleActionRoutes({
      req: fakeReq,
      res: fakeRes,
      pathname: "/api/actions/queue/start",
      url: new URL("http://localhost/api/actions/queue/start"),
      auth: { userId: "user-1", username: "tester" },
    }, {
      allowedDirs: [repoDir],
    });

    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 200);

    const parsed = JSON.parse(responseBody);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.dequeuedJobId, job.jobId);

    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "codex/issue-991");
  });

  it("resolves a project id to its workspace before manually starting the queue", async () => {
    const db = getStateDatabase();
    addWebProjectMapping(db, "project-hash");

    const bus = new LaneDispatchBus(db, { testCommand: "git status" });
    setBusInstance(bus);
    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 992,
      issueTitle: "Resolve project workspace before queue start",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify project resolution"],
    });

    const reqPayload = Buffer.from(JSON.stringify({ projectId: "project-hash" }), "utf8");
    const fakeReq: any = {
      method: "POST",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield reqPayload;
      },
    };

    let responseBody = "";
    let statusCode = 200;
    const fakeRes: any = {
      writeHead(code: number) { statusCode = code; },
      setHeader() {},
      end(data: string) { responseBody = data; },
    };

    fakeReq.method = "GET";
    const listed = await handleActionRoutes({
      req: fakeReq,
      res: fakeRes,
      pathname: "/api/actions/jobs",
      url: new URL("http://localhost/api/actions/jobs?projectId=project-hash"),
      auth: { userId: "user-1", username: "tester" },
    }, {
      allowedDirs: [repoDir],
    });

    assert.strictEqual(listed, true);
    assert.ok((JSON.parse(responseBody) as Array<{ id: string }>).some((item) => item.id === job.jobId));

    fakeReq.method = "POST";
    const handled = await handleActionRoutes({
      req: fakeReq,
      res: fakeRes,
      pathname: "/api/actions/queue/start",
      url: new URL("http://localhost/api/actions/queue/start"),
      auth: { userId: "user-1", username: "tester" },
    }, {
      allowedDirs: [repoDir],
    });

    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(JSON.parse(responseBody).dequeuedJobId, job.jobId);

    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "codex/issue-992");
  });

  it("rejects queue access when the project belongs to another user", async () => {
    const db = getStateDatabase();
    addWebProjectMapping(db, "project-hash", "user-2");
    const bus = new LaneDispatchBus(db);
    setBusInstance(bus);
    bus.dispatchJob({
      projectId: "project-hash",
      issueId: 993,
      issueTitle: "Reject unauthorized queue access",
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify authorization"],
    });

    const fakeReq: any = {
      method: "POST",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ projectId: "project-hash" }), "utf8");
      },
    };
    let statusCode = 200;
    const fakeRes: any = {
      writeHead(code: number) { statusCode = code; },
      setHeader() {},
      end() {},
    };

    const handled = await handleActionRoutes({
      req: fakeReq,
      res: fakeRes,
      pathname: "/api/actions/queue/start",
      url: new URL("http://localhost/api/actions/queue/start"),
      auth: { userId: "user-1", username: "tester" },
    }, {
      allowedDirs: [repoDir],
    });

    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 400);
    assert.strictEqual(spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(), "dev");
  });

  it("initializes web project tables before resolving action routes", async () => {
    const db = getStateDatabase();
    setBusInstance(new LaneDispatchBus(db));
    assert.strictEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_projects'").get(),
      undefined,
    );

    const fakeReq: any = { method: "GET", headers: {} };
    let statusCode = 200;
    const fakeRes: any = {
      writeHead(code: number) { statusCode = code; },
      setHeader() {},
      end() {},
    };

    const handled = await handleActionRoutes({
      req: fakeReq,
      res: fakeRes,
      pathname: "/api/actions/jobs",
      url: new URL("http://localhost/api/actions/jobs?projectId=missing-project"),
      auth: { userId: "user-1", username: "tester" },
    }, {
      allowedDirs: [repoDir],
    });

    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 400);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_projects'").get(),
    );
  });

  function dispatchJob(bus: LaneDispatchBus, issueId: number, issueTitle: string): string {
    return bus.dispatchJob({
      projectId: repoDir,
      issueId,
      issueTitle,
      issueDescription: "Complete issue description",
      acceptanceCriteria: ["Verify reconciliation"],
    }).jobId;
  }

  function blockJob(bus: LaneDispatchBus, jobId: string, prNumber?: number): string {
    // Two identical rejections trip the repeated-failure short circuit and block the job.
    for (const reworkCount of [0, 1]) {
      bus.handleReviewResult({ jobId, repoPath: repoDir, verdict: "REJECT", reviewSummary: "Identical defect", reworkCount });
    }
    if (prNumber !== undefined) updateActionJobStatus(getStateDatabase(), jobId, "blocked", { pr_number: prNumber });
    return jobId;
  }

  function busWithPrStates(states: Record<number, Partial<PullRequestStateResult>>): LaneDispatchBus {
    const baseline: PullRequestStateResult = { state: null, merged: false, baseRefName: null, mergedAt: null };
    return new LaneDispatchBus(getStateDatabase(), {
      pullRequestStateReader: ({ prNumber }) => ({ ...baseline, ...states[prNumber] }),
    });
  }

  it("converges only pull requests merged into the expected base branch", () => {
    const bus = busWithPrStates({
      900: { merged: true, baseRefName: "dev" },
      901: { merged: true, baseRefName: "main" },
      902: { merged: false, baseRefName: "dev" },
      903: { error: "gh unavailable" },
    });
    const convergedId = blockJob(bus, dispatchJob(bus, 4501, "Merged into dev"), 900);
    const mismatchedId = blockJob(bus, dispatchJob(bus, 4502, "Merged into main"), 901);
    const openId = blockJob(bus, dispatchJob(bus, 4503, "Still open"), 902);
    const unreadId = blockJob(bus, dispatchJob(bus, 4504, "Unreadable state"), 903);

    assert.strictEqual(bus.getJob(convergedId)?.status, "blocked");
    assert.strictEqual(bus.reconcileJobsWithGitHub(repoDir, repoDir).length, 1);

    const converged = bus.getJob(convergedId);
    assert.strictEqual(converged?.status, "completed");
    assert.strictEqual(converged?.blocked_at, null);
    assert.strictEqual(converged?.error_message, null);

    const mismatched = bus.getJob(mismatchedId);
    assert.strictEqual(mismatched?.status, "blocked");
    assert.match(mismatched?.error_message ?? "", /merged into 'main' instead of 'dev'/);
    assert.strictEqual(bus.getJob(openId)?.status, "blocked");
    assert.strictEqual(bus.getJob(unreadId)?.status, "blocked");
  });

  it("resolves a blocked job through dismiss", () => {
    const bus = new LaneDispatchBus(getStateDatabase());
    const dismissId = blockJob(bus, dispatchJob(bus, 4510, "Dismiss me"));
    assert.deepStrictEqual(bus.resolveJob(dismissId, "dismiss"), { ok: true, status: "failed" });
    assert.strictEqual(bus.getJob(dismissId)?.blocked_at, null);
    assert.strictEqual(bus.getJob(dismissId)?.error_message, "Dismissed by operator.");

    const notedId = blockJob(bus, dispatchJob(bus, 4511, "Dismiss with note"));
    assert.deepStrictEqual(bus.resolveJob(notedId, "dismiss", { note: "superseded" }), { ok: true, status: "failed" });
    assert.strictEqual(bus.getJob(notedId)?.blocked_at, null);
    assert.strictEqual(bus.getJob(notedId)?.error_message, "superseded");
  });

  it("refuses to resolve a job that is not blocked", () => {
    const bus = new LaneDispatchBus(getStateDatabase());
    const jobId = dispatchJob(bus, 4520, "Still running");

    const result = bus.resolveJob(jobId, "dismiss");
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? "", /is 'queued'; only blocked jobs can be resolved/);
    assert.strictEqual(bus.getJob(jobId)?.status, "queued");
  });

  it("stops cancel from re-evaluating the queue", async () => {
    const bus = new LaneDispatchBus(getStateDatabase());
    const jobId = dispatchJob(bus, 4530, "Cancellation side effects");
    let evaluations = 0;
    const original = bus.evaluateQueue.bind(bus);
    (bus as unknown as { evaluateQueue: typeof original }).evaluateQueue = ((...args: Parameters<typeof original>) => {
      evaluations += 1;
      return original(...args);
    }) as typeof original;

    bus.cancelJob(jobId, repoDir);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(bus.getJob(jobId)?.status, "cancelled");
    assert.strictEqual(evaluations, 0);
  });

  it("serves the resolve endpoint and rejects non-blocked jobs over HTTP", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);
    setBusInstance(bus);
    addWebProjectMapping(db, repoDir);
    const jobId = blockJob(bus, dispatchJob(bus, 4540, "Endpoint probe"));

    async function postResolve(targetId: string, payload: Record<string, unknown>) {
      const routePath = `/api/actions/jobs/${encodeURIComponent(targetId)}/resolve`;
      const fakeReq: any = {
        method: "POST",
        headers: {},
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); },
      };
      let statusCode = 200;
      let responseBody = "";
      const fakeRes: any = {
        writeHead(code: number) { statusCode = code; },
        setHeader() {},
        end(data: string) { responseBody = data; },
      };
      const handled = await handleActionRoutes({
        req: fakeReq, res: fakeRes, pathname: routePath,
        url: new URL(`http://localhost${routePath}`),
        auth: { userId: "user-1", username: "tester" },
      }, { allowedDirs: [repoDir] });
      return { handled, statusCode, body: responseBody ? JSON.parse(responseBody) : null };
    }

    const dismissed = await postResolve(jobId, { action: "dismiss", projectId: repoDir });
    assert.strictEqual(dismissed.handled, true);
    assert.strictEqual(dismissed.statusCode, 200);
    assert.strictEqual(dismissed.body.status, "failed");
    assert.strictEqual(bus.getJob(jobId)?.blocked_at, null);

    const queuedId = dispatchJob(bus, 4541, "Not blocked");
    const rejected = await postResolve(queuedId, { action: "dismiss", projectId: repoDir });
    assert.strictEqual(rejected.statusCode, 409);
    assert.strictEqual(bus.getJob(queuedId)?.status, "queued");
    assert.strictEqual((await postResolve(jobId, { action: "resume", projectId: repoDir })).statusCode, 400);
    assert.strictEqual((await postResolve(jobId, { action: "complete", projectId: repoDir })).statusCode, 400);
    assert.strictEqual((await postResolve(jobId, { action: "abandon", projectId: repoDir })).statusCode, 400);
  });

});

describe("Actions failure classification", () => {
  it("spends rework budget on implementation failures", () => {
    assert.strictEqual(classifyActionsFailure({ failureClass: "implementation", attemptIndex: 1, repeated: false }), "rework");
    assert.strictEqual(classifyActionsFailure({ failureClass: "implementation", attemptIndex: 2, repeated: false }), "rework");
  });

  it("blocks an implementation failure that repeats or exhausts the budget", () => {
    assert.strictEqual(classifyActionsFailure({ failureClass: "implementation", attemptIndex: 2, repeated: true }), "block-exhausted");
    assert.strictEqual(classifyActionsFailure({ failureClass: "implementation", attemptIndex: 3, repeated: false }), "block-exhausted");
  });

  it("blocks an infrastructure failure on the first attempt without rework", () => {
    assert.strictEqual(classifyActionsFailure({ failureClass: "infrastructure", attemptIndex: 1, repeated: false }), "block-infrastructure");
  });
});

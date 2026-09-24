import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { LaneDispatchBus } from "../../server/actions/bus.js";
import { checkThreePointGate } from "../../server/actions/threePointGate.js";
import { updateActionJobStatus } from "../../server/state/actionJobStore.js";

describe("LaneDispatchBus & ThreePointCheckoutGate", () => {
  let tmpDir: string;
  let repoDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-bus-test-"));
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

  it("dispatches a job non-blockingly with formatted id and queued status", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const start = Date.now();
    const result = bus.dispatchJob({
      projectId: "/home/andy/repos/ads",
      issueId: 277,
      issueTitle: "Acopilot & Actions refactor",
    });
    const elapsed = Date.now() - start;

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "queued");
    assert.ok(result.jobId.startsWith("job-"));
    assert.ok(result.jobId.includes("-277-"));
    assert.ok(elapsed < 50, `Dispatch should be fast, elapsed: ${elapsed}ms`);

    const stored = bus.getJob(result.jobId);
    assert.ok(stored);
    assert.strictEqual(stored.status, "queued");
    assert.strictEqual(stored.branch, "codex/issue-277");
  });

  it("evaluates Three-Point Gate: blocks when previous job is non-terminal", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job1 = bus.dispatchJob({
      projectId: repoDir,
      issueId: 101,
      issueTitle: "Task 1",
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
    });

    const res = await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.dequeuedJobId, job.jobId);

    const activeJob = bus.getJob(job.jobId);
    assert.ok(activeJob?.status === "running" || activeJob?.status === "waiting_merge");

    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "codex/issue-202");
  });

  it("handles reviewer PASS and transitions to waiting_merge", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 303,
      issueTitle: "Task 303",
    });

    const res = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "PASS",
      reviewSummary: "LGTM",
    });

    assert.strictEqual(res.status, "waiting_merge");
    const updated = bus.getJob(job.jobId);
    assert.strictEqual(updated?.status, "waiting_merge");
    assert.strictEqual(updated?.pr_number, null);
    assert.ok(updated?.current_step?.includes("Local repository ready"));
  });

  it("merges local branch via fast-forward fallback when no PR number exists", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 505,
      issueTitle: "Offline task",
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

    // Execute merge
    const mergeRes = bus.executeDeterministicMerge(job.jobId, repoDir);
    assert.strictEqual(mergeRes.success, true);

    // Verify dev now has the commit and feature branch is cleaned up
    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "dev");
    assert.ok(fs.existsSync(path.join(repoDir, "feature.txt")));
  });

  it("handles reviewer REJECT with rework bounds (max 2)", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 404,
      issueTitle: "Task 404",
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

    // Attempt 2 -> running (rework)
    const r2 = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Defect 2",
      reworkCount: 1,
    });
    assert.strictEqual(r2.status, "running");

    // Attempt 3 -> failed (limit exceeded)
    const r3 = bus.handleReviewResult({
      jobId: job.jobId,
      repoPath: repoDir,
      verdict: "REJECT",
      reviewSummary: "Defect 3",
      reworkCount: 2,
    });
    assert.strictEqual(r3.status, "failed");
  });

  it("cancels a job when requested", () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueTitle: "To Cancel",
    });

    bus.cancelJob(job.jobId, repoDir);
    const updated = bus.getJob(job.jobId);
    assert.strictEqual(updated?.status, "cancelled");
    assert.strictEqual(spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim(), "dev");
  });

  it("runs full automated job cycle through verification and review", async () => {
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db);

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 606,
      issueTitle: "Automated cycle",
    });

    // Start job
    await bus.evaluateQueue(repoDir, repoDir);

    // Run cycle
    await bus.runJobCycle(job.jobId, repoDir, {
      testCommand: "git status",
    });

    const finishedJob = bus.getJob(job.jobId);
    assert.strictEqual(finishedJob?.status, "waiting_merge");
    assert.ok(finishedJob?.review_verdicts_json.includes("PASS"));
  });

  it("invokes developer runner on dequeue and triggers review upon exit 0", async () => {
    const db = getStateDatabase();
    let devRan = false;

    const bus = new LaneDispatchBus(db, {
      developerRunner: async (job, rPath) => {
        devRan = true;
        assert.strictEqual(job.issue_id, 707);
        assert.strictEqual(rPath, repoDir);
        // Simulate developer making a commit on feature branch
        fs.writeFileSync(path.join(repoDir, "feature707.txt"), "done");
        spawnSync("git", ["add", "feature707.txt"], { cwd: repoDir });
        spawnSync("git", ["commit", "-m", "feature 707"], { cwd: repoDir });
        return { exitCode: 0 };
      },
      testCommand: "git status",
    });

    const job = bus.dispatchJob({
      projectId: repoDir,
      issueId: 707,
      issueTitle: "Test dev runner",
    });

    await bus.evaluateQueue(repoDir, repoDir);
    assert.strictEqual(devRan, true);
  });

  it("routes reviewer rejection defect feedback back to developer for rework", async () => {
    const db = getStateDatabase();
    let devCalls = 0;
    let receivedFeedback: string | undefined;

    const bus = new LaneDispatchBus(db, {
      developerRunner: async (job, rPath, reworkFeedback) => {
        devCalls++;
        receivedFeedback = reworkFeedback;
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
        return () => {};
      },
      setDeveloperInstructions: (inst: string) => {
        instructionsSet = inst;
      },
      invokeAgent: async (_agentId: string, input: any) => {
        turnPrompt = typeof input === "string" ? input : input[0]?.text || "";
        return { response: "Implemented changes successfully", usage: { input_tokens: 10, output_tokens: 20 } };
      },
      send: async (input: any) => {
        turnPrompt = typeof input === "string" ? input : input[0]?.text || "";
        return { response: "Implemented changes successfully", usage: { input_tokens: 10, output_tokens: 20 } };
      },
    };

    const mockSessionManager = {
      getOrCreate: () => mockOrchestrator,
    };

    const bus = new LaneDispatchBus(db, {
      sessionManager: mockSessionManager as any,
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
    });

    await bus.evaluateQueue(repoDir, repoDir);

    // Wait for async execution turn to complete
    for (let i = 0; i < 50; i++) {
      if (streamedEvents.some((e) => e.payload.type === "assistant_done")) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify session turn executed
    assert.ok(turnPrompt.includes("Issue #909"));
    assert.ok(instructionsSet.length > 0);

    // Verify event streaming to Actions lane
    assert.ok(streamedEvents.some((e) => e.payload.type === "message" && e.payload.role === "user"));
    assert.ok(streamedEvents.some((e) => e.payload.type === "step" && e.payload.title === "Analyzing repository"));
    assert.ok(streamedEvents.some((e) => e.payload.type === "command" && e.payload.title === "Running check"));
    assert.ok(streamedEvents.some((e) => e.payload.type === "assistant_done"));

    // Verify history recording
    assert.ok(historyEntries.some((h) => h.entry.role === "user"));
    assert.ok(historyEntries.some((h) => h.entry.role === "assistant"));

    // Wait for full cycle (verification + reviewer) to complete
    for (let i = 0; i < 50; i++) {
      const current = bus.getJob(job.jobId);
      if (current?.status === "waiting_merge") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify verification and reviewer events streamed to Actions lane
    assert.ok(streamedEvents.some((e) => e.payload.type === "step" && e.payload.title?.includes("Verification")));
    assert.ok(streamedEvents.some((e) => e.payload.type === "command" && e.payload.command === "git status"));
    assert.ok(streamedEvents.some((e) => e.payload.type === "step" && e.payload.title?.includes("Reviewer")));
    assert.ok(streamedEvents.some((e) => e.payload.type === "message" && e.payload.text?.includes("Code Review")));

    // Verify history recording for review verdict
    assert.ok(historyEntries.some((h) => h.entry.kind === "review_verdict"));
  });
});

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
import { getDefaultRoleProfile, saveRoleProfile } from "../../server/state/roleProfileStore.js";
import type { completeNativeChat } from "../../server/runtime/openAiCompatibleClient.js";
import type { completeNativeModel } from "../../server/runtime/nativeCompletion.js";

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
    fs.writeFileSync(
      path.join(repoDir, "verification-stream.cjs"),
      [
        'process.stdout.write("stdout");',
        'setTimeout(() => process.stderr.write("stderr"), 5);',
        'setTimeout(() => process.stdout.write("-line\\n"), 10);',
        'setTimeout(() => process.stderr.write("-line\\n"), 15);',
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(repoDir, "verification-truncate.cjs"),
      'for (let index = 0; index <= 40; index += 1) console.log(`verification-${index}`);\n',
    );
    fs.writeFileSync(
      path.join(repoDir, "verification-fail.cjs"),
      'console.error("fixture failure: expected 2, received 3");\nprocess.exit(1);\n',
    );
    spawnSync("git", ["add", "README.md", "verification-stream.cjs", "verification-truncate.cjs", "verification-fail.cjs"], { cwd: repoDir });
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
      onIssueComment?: (body: string) => void;
      onWake?: (args: { issueId: number; status: string; jobId: string }) => void;
      reviewerRunner?: (prompt: string) => Promise<string>;
      useInspection?: boolean;
      reviewerComplete?: typeof completeNativeChat;
      reviewPresentationComplete?: typeof completeNativeModel;
      reviewPresentationTimeoutMs?: number;
    } = {},
  ): LaneDispatchBus {
    let metadataReads = 0;
    const current = getTarget;
    return new LaneDispatchBus(getStateDatabase(), {
      testCommand: options.testCommand ?? "git status",
      interactiveVerificationTimeoutMs: options.interactiveVerificationTimeoutMs,
      reviewPresentationTimeoutMs: options.reviewPresentationTimeoutMs,
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
      ...(options.useInspection
        ? {
            reviewerModelResolver: () => ({
              model: "reviewer-test",
              baseUrl: "http://invalid",
              apiKey: "test",
              provider: "test",
              wireApi: "chat" as const,
              contextWindow: 200_000,
              options: {},
            }),
            reviewerComplete: options.reviewerComplete,
          }
        : {
            reviewerRunner: options.reviewerRunner ?? (async (prompt) => {
              options.onReviewPrompt?.(prompt);
              const status = options.reviewStatus ?? "PASS";
              return JSON.stringify({
                status,
                summary: status === "PASS" ? "Exact target reviewed" : "Defect found",
                defects: status === "PASS" ? [] : [{ file: "change.txt", severity: "blocker", description: "Fixture defect" }],
              });
            }),
          }),
      ...(options.reviewPresentationComplete
        ? {
            reviewPresentationModelResolver: () => ({
              model: "presentation-test",
              baseUrl: "http://invalid",
              apiKey: "test",
              provider: "test",
              wireApi: "chat" as const,
              contextWindow: 200_000,
              options: {},
            }),
            reviewPresentationComplete: options.reviewPresentationComplete,
          }
        : {}),
      publishIssueComment: ({ body }) => {
        options.onIssueComment?.(body);
        return { ok: true };
      },
      wakeAcopilotLane: (args) => options.onWake?.(args),
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

  async function runReview(
    bus: LaneDispatchBus,
    reviewTarget: InteractiveReviewTarget,
    signal?: AbortSignal,
  ): Promise<{
    ack: { ok: boolean; jobId?: string; error?: string; [key: string]: unknown };
    job: ReturnType<LaneDispatchBus["getJob"]>;
    result: { ok: boolean; jobId?: string; status?: string; verdict?: { status?: string }; error?: string };
    tools: Awaited<ReturnType<LaneDispatchBus["createInteractiveActionTools"]>>;
  }> {
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget, signal));
    const ack = await tools.review_action();
    await bus.processReviewQueue(reviewTarget.projectId, repoDir);
    const job = ack.jobId ? bus.getJob(String(ack.jobId)) : null;
    let verdict: { status?: string } | undefined;
    try {
      const parsed = JSON.parse(job?.review_verdicts_json || "[]") as Array<{ status?: string }>;
      verdict = parsed.at(-1);
    } catch {
      verdict = undefined;
    }
    const result = ack.ok === false
      ? ack
      : verdict
        ? { ok: true, jobId: job?.id, status: job?.status, verdict }
        : { ok: false, jobId: job?.id, status: job?.status, error: job?.error_message ?? job?.current_step ?? "no verdict" };
    return { ack, job, result, tools };
  }

  async function settlePresentation(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    const { result, tools } = await runReview(bus, reviewTarget);

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
    await settlePresentation();
    assert.ok(history.some((entry) => entry.kind === `action_step:${job.id}:result`));
    assert.ok(broadcasts.some((payload) => (payload as { kind?: string }).kind === `action_step:${job.id}:result`));
    await tools.dispose();
  });

  it("returns REJECT as a completed review result without treating it as an operational failure", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, { reviewStatus: "REJECT" });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true);
    assert.equal((result.verdict as { status: string }).status, "REJECT");
    assert.equal(bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0]?.status, "completed");
    await tools.dispose();
  });

  it("runs the Reviewer when the verification command exits non-zero", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    let reviewPrompt = "";
    const bus = createBus(() => reviewTarget, {
      testCommand: "node verification-fail.cjs",
      reviewStatus: "REJECT",
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
      onHistoryMessage: (entry) => history.push(entry),
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.verdict as { status: string }).status, "REJECT");
    assert.ok(reviewPrompt.includes("Command: node verification-fail.cjs"));
    assert.ok(reviewPrompt.includes("Exit Code: 1"));
    assert.ok(reviewPrompt.includes("fixture failure: expected 2, received 3"));
    assert.ok(reviewPrompt.includes("A non-zero exit code is evidence for your review"));
    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];
    assert.equal(job?.status, "completed");
    assert.equal(JSON.parse(job?.verification_report_json ?? "{}").exitCode, 1);
    assert.ok(
      history.some((entry) => entry.text.includes("Checks failed for PR #901 · Interactive review")),
      JSON.stringify(history.map((entry) => entry.text)),
    );
    await tools.dispose();
  });

  it("uses a dedicated prompt to narrate a complete Actions-lane review summary", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    const db = getStateDatabase();
    const profile = getDefaultRoleProfile(db, "acopilot");
    assert.ok(profile);
    saveRoleProfile(db, {
      ...profile,
      model_id: "presentation-model",
      system_prompt: "Configured Acopilot presentation prompt",
      is_enabled: true,
      is_default: true,
    });
    let presentationRequest: Parameters<typeof completeNativeModel>[0] | undefined;
    const bus = createBus(() => reviewTarget, {
      onHistoryMessage: (entry) => history.push(entry),
      reviewPresentationComplete: async (request) => {
        presentationRequest = request;
        return {
          text: "审查通过。验证完成，未发现需要修改的问题。",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    assert.ok(presentationRequest);
    assert.match(String(presentationRequest.messages[0]?.content), /concise, neutral explanation/);
    assert.doesNotMatch(String(presentationRequest.messages[0]?.content), /Configured Acopilot/);
    assert.match(String(presentationRequest.messages[1]?.content), /<review-verdict>/);
    assert.deepEqual(presentationRequest.tools, []);
    await settlePresentation();
    const presentation = history.find((entry) => entry.kind?.endsWith(":result"));
    assert.ok(presentation);
    assert.match(presentation.text, /^审查通过。验证完成，未发现需要修改的问题。\n\nReviewer verdict: PASS/);
    assert.match(presentation.text, /Exact target reviewed/);
    assert.equal(presentation.role, "status");
    assert.equal(presentation.text.includes('"status"'), false);
    await tools.dispose();
  });

  it("falls back to deterministic text when the presentation model returns protocol JSON", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    const db = getStateDatabase();
    const profile = getDefaultRoleProfile(db, "acopilot");
    assert.ok(profile);
    saveRoleProfile(db, {
      ...profile,
      model_id: "presentation-model",
      system_prompt: "Configured Acopilot presentation prompt",
      is_enabled: true,
      is_default: true,
    });
    const bus = createBus(() => reviewTarget, {
      onHistoryMessage: (entry) => history.push(entry),
      reviewPresentationComplete: async () => ({
        text: JSON.stringify({ status: "PASS", summary: "Internal protocol", defects: [] }),
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      }),
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    await settlePresentation();
    const presentation = history.find((entry) => entry.kind?.endsWith(":result"));
    assert.ok(presentation);
    assert.match(presentation.text, /^Reviewer verdict: PASS/);
    assert.match(presentation.text, /Exact target reviewed/);
    assert.equal(presentation.text.includes('"status"'), false);
    await tools.dispose();
  });

  it("appends every authoritative finding after a concise narration", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    const db = getStateDatabase();
    const profile = getDefaultRoleProfile(db, "acopilot");
    assert.ok(profile);
    saveRoleProfile(db, {
      ...profile,
      model_id: "presentation-model",
      system_prompt: "Ignored by the dedicated presentation prompt",
      is_enabled: true,
      is_default: true,
    });
    const bus = createBus(() => reviewTarget, {
      onHistoryMessage: (entry) => history.push(entry),
      reviewerRunner: async () => JSON.stringify({
        status: "REJECT",
        summary: "Two defects need attention",
        defects: [
          { file: "server/a.ts", line: 7, severity: "blocker", description: "Missing guard" },
          { file: "server/b.ts", line: 11, severity: "warning", description: "Missing test" },
        ],
      }),
      reviewPresentationComplete: async () => ({
        text: "The review identified follow-up work.",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      }),
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    await settlePresentation();
    const presentation = history.find((entry) => entry.kind?.endsWith(":result"));
    assert.ok(presentation);
    assert.match(presentation.text, /^The review identified follow-up work\./);
    assert.match(presentation.text, /server\/a\.ts:7 \(blocker\): Missing guard/);
    assert.match(presentation.text, /server\/b\.ts:11 \(warning\): Missing test/);
    await tools.dispose();
  });

  it("falls back after a presentation timeout without changing the completed verdict", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    const db = getStateDatabase();
    const profile = getDefaultRoleProfile(db, "acopilot");
    assert.ok(profile);
    saveRoleProfile(db, {
      ...profile,
      model_id: "presentation-model",
      system_prompt: "Ignored by the dedicated presentation prompt",
      is_enabled: true,
      is_default: true,
    });
    const bus = createBus(() => reviewTarget, {
      onHistoryMessage: (entry) => history.push(entry),
      reviewPresentationTimeoutMs: 10,
      reviewPresentationComplete: async () => await new Promise(() => {}),
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.verdict as { status?: string }).status, "PASS");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const presentation = history.find((entry) => entry.kind?.endsWith(":result"));
    assert.ok(presentation);
    assert.match(presentation.text, /^Reviewer verdict: PASS/);
    await tools.dispose();
  });

  it("persists the pinned deterministic verdict before an asynchronous narration", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    let releaseNarration: (() => void) | undefined;
    let narrationStarted = false;
    let markNarrationStarted: (() => void) | undefined;
    const narrationStartedPromise = new Promise<void>((resolve) => { markNarrationStarted = resolve; });
    const bus = createBus(() => reviewTarget, {
      onHistoryMessage: (entry) => history.push(entry),
      reviewPresentationComplete: async () => await new Promise((resolve) => {
        narrationStarted = true;
        markNarrationStarted?.();
        releaseNarration = () => resolve({
          text: "The exact target was reviewed successfully.",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        });
      }),
    });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const ack = await tools.review_action();
    assert.equal(ack.ok, true, ack.error);
    await bus.processReviewQueue(reviewTarget.projectId, repoDir);
    await narrationStartedPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const reviewed = bus.getJob(String(ack.jobId));
    assert.equal(reviewed?.status, "completed");
    assert.equal(narrationStarted, true);
    const completed = history.find((entry) => entry.kind?.endsWith(":completed"));
    assert.ok(completed);
    assert.match(completed.text, /^Review complete for PR #901 · Interactive review\./);
    assert.equal(completed.text.includes(reviewed!.id), false);
    assert.equal(completed.text.includes(headCommit.slice(0, 12)), false);
    assert.match(completed.text, /^Reviewer verdict: PASS/m);
    assert.match(completed.text, /Exact target reviewed/);
    releaseNarration?.();
    await settlePresentation();
    assert.ok(history.some((entry) => entry.kind?.endsWith(":result")));
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
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    const jobs = bus.getJobs(reviewTarget.projectId, repoDir, "user-1");
    const interrupted = jobs.find((job) => job.id === "interrupted-review");
    assert.equal(interrupted?.status, "failed");
    assert.deepEqual(JSON.parse(interrupted?.review_verdicts_json ?? "[]"), []);
    assert.match(interrupted?.error_message ?? "", /no active worker/);
    assert.equal(jobs.filter((job) => job.status === "completed").length, 1);
    await tools.dispose();
  });

  it("reports a target change during review as INCOMPLETE instead of a failed job", async () => {
    let reviewTarget = target();
    const comments: string[] = [];
    const wakes: Array<{ issueId: number; status: string; jobId: string }> = [];
    const bus = createBus(() => reviewTarget, {
      onMetadataRead: (count) => {
        if (count === 2) reviewTarget = target({ prNumber: 902, prUrl: "https://github.invalid/pull/902" });
      },
      onIssueComment: (body) => comments.push(body),
      onWake: (args) => wakes.push(args),
    });
    const { result, tools } = await runReview(bus, reviewTarget);
    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];

    assert.equal(result.ok, true, result.error);
    assert.ok(job);
    assert.equal(job.status, "completed");
    const verdict = JSON.parse(job.review_verdicts_json)[0] as { status: string };
    assert.equal(verdict.status, "INCOMPLETE");
    assert.equal(comments.length, 1);
    assert.match(comments[0]!, /^## ADS Reviewer verdict: INCOMPLETE$/m);
    assert.deepEqual(wakes.map((wake) => wake.status), ["INCOMPLETE"]);
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

  it("returns before the review runs and keeps the queued job after the turn aborts", async () => {
    const reviewTarget = target();
    const controller = new AbortController();
    const bus = createBus(() => reviewTarget);
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget, controller.signal));

    const ack = await tools.review_action();
    assert.equal(ack.ok, true, ack.error);
    assert.equal(ack.status, "queued");
    controller.abort(new Error("Acopilot request aborted"));
    await bus.processReviewQueue(reviewTarget.projectId, repoDir);

    const job = bus.getJob(String(ack.jobId));
    assert.ok(job);
    assert.equal(job.status, "completed");
    assert.equal(JSON.parse(job.review_verdicts_json)[0].status, "PASS");
    await tools.dispose();
  });

  it("acknowledges the job before target checks and reports a dirty workspace as INCOMPLETE", async () => {
    const reviewTarget = target();
    fs.appendFileSync(path.join(repoDir, "README.md"), "dirty\n");
    const comments: string[] = [];
    const wakes: Array<{ issueId: number; status: string }> = [];
    const bus = createBus(() => reviewTarget, {
      onIssueComment: (body) => comments.push(body),
      onWake: (args) => wakes.push(args),
    });
    const { ack, job, tools } = await runReview(bus, reviewTarget);
    assert.equal(ack.ok, true, ack.error);
    assert.equal(ack.issueId, 900);
    assert.equal(job?.status, "completed");
    assert.equal(JSON.parse(job?.review_verdicts_json ?? "[]")[0].status, "INCOMPLETE");
    assert.match(job?.current_step ?? "", /uncommitted tracked changes/i);
    assert.equal(job?.base_sha, "");
    assert.equal(comments.length, 1);
    assert.match(comments[0]!, /^## ADS Reviewer verdict: INCOMPLETE$/m);
    assert.deepEqual(wakes.map((wake) => wake.status), ["INCOMPLETE"]);
    assert.equal(wakes[0]?.issueId, 900);
    await tools.dispose();
  });

  it("reports a missing or ambiguous Issue-backed PR as INCOMPLETE", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, { openPullRequests: [] });
    const { job, tools } = await runReview(bus, reviewTarget);
    assert.equal(job?.status, "completed");
    const verdict = JSON.parse(job?.review_verdicts_json ?? "[]")[0] as { status: string; summary: string };
    assert.equal(verdict.status, "INCOMPLETE");
    assert.match(verdict.summary, /Expected exactly one open pull request/);
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

  it("passes a verification timeout to the Reviewer instead of aborting the job", async () => {
    const reviewTarget = target();
    let reviewPrompt = "";
    const bus = createBus(() => reviewTarget, {
      testCommand: "node -e setTimeout(()=>{},10000)",
      interactiveVerificationTimeoutMs: 50,
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
    });
    const { result, job, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    assert.equal((result.verdict as { status: string }).status, "PASS");
    assert.equal(job?.status, "completed");
    assert.equal(JSON.parse(job?.verification_report_json ?? "{}").exitCode, 124);
    assert.match(reviewPrompt, /Exit Code: 124/);
    assert.match(reviewPrompt, /Verification timed out/);
    await tools.dispose();
  });

  it("records human review milestones without Reviewer inspection steps", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    const broadcasts: unknown[] = [];
    let calls = 0;
    const bus = createBus(() => reviewTarget, {
      useInspection: true,
      testCommand: "git status --porcelain=v1 --branch",
      onHistoryMessage: (entry) => history.push(entry),
      onBroadcast: (payload) => broadcasts.push(payload),
      reviewerComplete: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: "",
            toolCalls: [{
              id: "call-1",
              type: "function",
              function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
            }],
            finishReason: "tool_calls",
            usage: null,
          };
        }
        return {
          text: JSON.stringify({ status: "PASS", summary: "Looks good", defects: [] }),
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    });
    const { result, job, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    const texts = history.map((entry) => entry.text);
    const verificationStatus = texts.find((text) => text.includes("Checks passed"));
    assert.ok(verificationStatus, JSON.stringify(texts));
    assert.ok(verificationStatus.includes("PR #901"), verificationStatus);
    assert.ok(verificationStatus.includes(reviewTarget.issue.title), verificationStatus);
    assert.equal(texts.some((text) => text.includes("## codex/issue-900")), false, JSON.stringify(texts));
    assert.equal(texts.some((text) => text.includes("Reviewer step") || text.includes("list_dir") || text.includes("offset=")), false, JSON.stringify(texts));
    assert.equal(texts.some((text) => text.includes(String(job?.id))), false, JSON.stringify(texts));
    assert.equal(JSON.stringify(broadcasts).includes("Reviewer step"), false, JSON.stringify(broadcasts));
    await settlePresentation();
    const verdictEntry = history.find((entry) => entry.kind?.endsWith(":result"));
    assert.ok(verdictEntry);
    assert.match(verdictEntry.text, /^Reviewer verdict: PASS/);
    assert.equal(verdictEntry.text.includes('"status"'), false);
    const completedTexts = history.map((entry) => entry.text);
    const completion = history.find((entry) => entry.kind?.endsWith(":completed"));
    assert.ok(completion);
    assert.match(completion.text, /^Review complete for PR #901 · Interactive review\./);
    assert.ok(completedTexts.indexOf(verificationStatus!) < completedTexts.indexOf(completion.text), JSON.stringify(completedTexts));
    assert.ok(completedTexts.indexOf(completion.text) < completedTexts.indexOf(verdictEntry.text), JSON.stringify(completedTexts));
    await tools.dispose();
  });

  it("passes both stdout and stderr to the Reviewer without streaming them into the lane", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    let reviewPrompt = "";
    const bus = createBus(() => reviewTarget, {
      testCommand: "node verification-stream.cjs",
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
      onHistoryMessage: (entry) => history.push(entry),
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    assert.ok(reviewPrompt.includes("stdout-line"), reviewPrompt);
    assert.ok(reviewPrompt.includes("stderr-line"), reviewPrompt);
    assert.equal(reviewPrompt.includes("stdoutstderr"), false, reviewPrompt);
    const texts = history.map((entry) => entry.text);
    assert.equal(texts.some((text) => text.includes("stdout-line") || text.includes("stderr-line")), false, JSON.stringify(texts));
    await tools.dispose();
  });

  it("returns queued immediately, then publishes the verdict comment and wakes Acopilot", async () => {
    const reviewTarget = target();
    const comments: string[] = [];
    const wakes: Array<{ issueId: number; status: string; jobId: string }> = [];
    const bus = createBus(() => reviewTarget, {
      testCommand: "node -e setTimeout(()=>{},1200)",
      interactiveVerificationTimeoutMs: 10_000,
      onIssueComment: (body) => comments.push(body),
      onWake: (args) => wakes.push(args),
    });
    const tools = await bus.createInteractiveActionTools(reviewRequest(reviewTarget));

    const startedAt = Date.now();
    const ack = await tools.review_action();
    const elapsed = Date.now() - startedAt;

    assert.equal(ack.ok, true, ack.error);
    assert.equal(ack.status, "queued");
    assert.ok(elapsed < 1000, `dispatch took ${elapsed}ms`);
    await bus.processReviewQueue(reviewTarget.projectId, repoDir);

    const job = bus.getJob(String(ack.jobId));
    assert.equal(job?.status, "completed");
    assert.equal(comments.length, 1);
    assert.ok(comments[0]!.startsWith("<!-- ads:review-verdict -->"));
    assert.match(comments[0]!, /^## ADS Reviewer verdict: PASS$/m);
    assert.match(comments[0]!, new RegExp(`^- Head: \`${headCommit.slice(0, 12)}\`$`, "m"));
    assert.match(comments[0]!, /^- Job: `/m);
    assert.deepEqual(wakes.map((wake) => wake.status), ["PASS"]);
    assert.equal(wakes[0]?.issueId, 900);
    assert.equal(wakes[0]?.jobId, job?.id);
    await tools.dispose();
  });

  it("keeps large verification output out of the lane while retaining it in the report", async () => {
    const reviewTarget = target();
    const history: Array<{ role: string; text: string; kind?: string }> = [];
    let reviewPrompt = "";
    const bus = createBus(() => reviewTarget, {
      testCommand: "node verification-truncate.cjs",
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
      onHistoryMessage: (entry) => history.push(entry),
    });
    const { result, tools } = await runReview(bus, reviewTarget);

    assert.equal(result.ok, true, result.error);
    assert.ok(reviewPrompt.includes("verification-0"), reviewPrompt);
    assert.ok(reviewPrompt.includes("verification-40"), reviewPrompt);
    const job = bus.getJobs(reviewTarget.projectId, repoDir, "user-1")[0];
    const report = JSON.parse(job?.verification_report_json ?? "{}") as { exitCode?: number; output?: string };
    assert.equal(report.exitCode, 0);
    assert.ok(report.output?.includes("verification-0"), report.output);
    assert.ok(report.output?.includes("verification-40"), report.output);
    const texts = history.map((entry) => entry.text);
    assert.equal(texts.some((text) => text.includes("verification-0")), false, JSON.stringify(texts));
    const verificationStatus = texts.find((text) => text.includes("Checks passed"));
    assert.ok(verificationStatus, JSON.stringify(texts));
    await settlePresentation();
    const verdictEntry = history.find((entry) => entry.kind?.endsWith(":result"));
    assert.ok(verdictEntry);
    const completedTexts = history.map((entry) => entry.text);
    assert.ok(completedTexts.indexOf(verificationStatus!) < completedTexts.indexOf(verdictEntry.text), JSON.stringify(completedTexts));
    await tools.dispose();
  });
});

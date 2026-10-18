import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import {
  LaneDispatchBus,
  type InteractiveReviewTarget,
} from "../../server/actions/bus.js";
import { handleActionRoutes, setBusInstance } from "../../server/web/server/api/routes/actions.js";
import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";

describe("interactive Actions review supervision", () => {
  const originalStateDbPath = process.env.ADS_STATE_DB_PATH;
  let tmpDir: string;
  let repoDir: string;
  let baseCommit: string;
  let headCommit: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-interactive-review-"));
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
    onMerge: (options: {
      cwd: string;
      prNumber?: number | null;
      issueId?: number | null;
      branch: string;
      baseBranch?: string;
      expectedHead?: string;
      expectedBaseSha?: string;
    }) => void,
    reviewStatus: "PASS" | "REJECT" = "PASS",
    options: {
      testCommand?: string;
      interactiveVerificationTimeoutMs?: number;
      onReviewPrompt?: (prompt: string) => void;
      onMetadataRead?: (count: number) => void;
    } = {},
  ): LaneDispatchBus {
    const current = getTarget;
    let metadataReads = 0;
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
          },
          issue: {
            number: value.issue.id!,
            title: value.issue.title,
            body: value.issue.description,
          },
        };
      },
      reviewerRunner: async (prompt) => {
        options.onReviewPrompt?.(prompt);
        return JSON.stringify({
          status: reviewStatus,
          summary: reviewStatus === "PASS" ? "Exact target reviewed" : "Defect found",
          defects: reviewStatus === "PASS" ? [] : [{ file: "change.txt", severity: "blocker", description: "Fixture defect" }],
        });
      },
      mergePipeline: (options) => {
        onMerge(options);
        return { success: true };
      },
    });
  }

  it("reviews and delivers an authenticated target only after PASS", async () => {
    const reviewTarget = target();
    let mergeOptions: {
      cwd: string;
      prNumber?: number | null;
      issueId?: number | null;
      branch: string;
      baseBranch?: string;
      expectedHead?: string;
      expectedBaseSha?: string;
    } | undefined;
    const bus = createBus(() => reviewTarget, (options) => { mergeOptions = options; });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, true, reviewed.error);
    assert.equal((reviewed.verdict as { status: string }).status, "PASS");
    const delivered = await tools.deliver_action();
    assert.equal(delivered.ok, true);
    assert.deepEqual(mergeOptions, {
      cwd: repoDir,
      prNumber: 901,
      issueId: 900,
      branch: "codex/issue-900",
      baseBranch: "dev",
      expectedHead: headCommit,
      expectedBaseSha: baseCommit,
    });
    await tools.dispose();
  });

  it("keeps the built-in reviewer capability available until invocation-time target validation", async () => {
    const bus = createBus(() => target(), () => {});
    const tools = await bus.createInteractiveActionTools({
      projectId: "not-a-real-project",
      repoPath: path.join(repoDir, "not-a-real-repo"),
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    assert.ok(tools);
    const result = await tools.review_action();
    assert.equal(result.ok, false);
    assert.match(String(result.error), /project workspace/);
    await tools.dispose();
  });

  it("reviews the authenticated workspace without a feature branch, clean worktree, or PR", async () => {
    spawnSync("git", ["checkout", "-b", "feature/local-review"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "change.txt"), "uncommitted local change\n");
    let reviewPrompt = "";
    const bus = createBus(() => target(), () => {}, "PASS", {
      testCommand: "git status",
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
    });
    const tools = await bus.createInteractiveActionTools({
      projectId: deriveProjectSessionId(repoDir),
      repoPath: repoDir,
      authUserId: "user-1",
      reviewPrompt: "Review the local implementation before opening a pull request.",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, true, reviewed.error);
    assert.match(reviewPrompt, /Interactive workspace review/);
    assert.match(reviewPrompt, /before opening a pull request/);
    assert.match(reviewPrompt, /uncommitted local change/);

    const delivered = await tools.deliver_action();
    assert.equal(delivered.ok, false);
    assert.match(String(delivered.error), /PR-scoped review/);
    await tools.dispose();
  });

  it("rejects delivery when the PR target changes after PASS", async () => {
    let reviewTarget = target();
    let merges = 0;
    const bus = createBus(() => reviewTarget, () => { merges += 1; });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, true, reviewed.error);
    reviewTarget = target({ prNumber: 902, prUrl: "https://github.invalid/pull/902" });
    const delivered = await tools.deliver_action();
    assert.equal(delivered.ok, false);
    assert.match(String(delivered.error), /Delivery target changed/);
    assert.equal(merges, 0);
    await tools.dispose();
  });

  it("invalidates delivery when the Issue snapshot changes after PASS", async () => {
    let reviewTarget = target();
    let merges = 0;
    const bus = createBus(() => reviewTarget, () => { merges += 1; });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, true, reviewed.error);
    reviewTarget = target({
      issue: {
        ...reviewTarget.issue,
        description: "Review this implementation.\n\n## Acceptance Criteria\n- Review the changed Issue snapshot.",
        acceptanceCriteria: ["Review the changed Issue snapshot."],
      },
    });
    const delivered = await tools.deliver_action();
    assert.equal(delivered.ok, false);
    assert.match(String(delivered.error), /Delivery target changed/);
    assert.equal(merges, 0);
    await tools.dispose();
  });

  it("fails closed when a changed ADR cannot be read", async () => {
    const adrDir = path.join(repoDir, "docs", "adr");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.symlinkSync("missing-target.md", path.join(adrDir, "0099-missing.md"));
    spawnSync("git", ["add", "docs/adr/0099-missing.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "add unreadable adr fixture"], { cwd: repoDir });
    headCommit = git("rev-parse", "HEAD");

    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, () => {});
    await assert.rejects(
      bus.resolveInteractiveReviewTarget({
        projectId: reviewTarget.projectId,
        repoPath: repoDir,
        authUserId: "user-1",
      }),
      /Unable to read changed ADR 'docs\/adr\/0099-missing\.md'/,
    );
  });

  it("pins the Reviewer prompt to the verified commits and reports executed checks", async () => {
    const reviewTarget = target();
    let reviewPrompt = "";
    const bus = createBus(() => reviewTarget, () => {}, "PASS", {
      onReviewPrompt: (prompt) => { reviewPrompt = prompt; },
    });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, true, reviewed.error);
    assert.ok(reviewPrompt.includes(`## Exact Diff Range:\n${baseCommit}..${headCommit}`));
    assert.ok(reviewPrompt.includes("Command: git status"));
    assert.ok(reviewPrompt.includes("Exit Code: 0"));
    await tools.dispose();
  });

  it("rejects a target that drifts while verification is running", async () => {
    let reviewTarget = target();
    const bus = createBus(() => reviewTarget, () => {}, "PASS", {
      onMetadataRead: (count) => {
        if (count === 2) {
          reviewTarget = target({ prNumber: 902, prUrl: "https://github.invalid/pull/902" });
        }
      },
    });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, false);
    assert.match(String(reviewed.error), /target changed/);
    await tools.dispose();
  });

  it("terminates verification when the interactive hard timeout expires", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, () => {}, "PASS", {
      testCommand: "node -e setTimeout(()=>{},10000)",
      interactiveVerificationTimeoutMs: 50,
    });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, false);
    assert.match(String(reviewed.error), /timed out/);
    await tools.dispose();
  });

  it("cancels an in-flight verification when the supervised tools are disposed", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, () => {}, "PASS", {
      testCommand: "node -e setTimeout(()=>{},10000)",
    });
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const review = tools.review_action();
    await Promise.resolve();
    await tools.dispose();
    await assert.rejects(review, /abort/i);
  });

  it("does not authorize delivery after a rejected review", async () => {
    const reviewTarget = target();
    let merges = 0;
    const bus = createBus(() => reviewTarget, () => { merges += 1; }, "REJECT");
    const tools = await bus.createInteractiveActionTools({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      authUserId: "user-1",
      signal: new AbortController().signal,
    });

    const reviewed = await tools.review_action();
    assert.equal(reviewed.ok, false);
    const delivered = await tools.deliver_action();
    assert.equal(delivered.ok, false);
    assert.match(String(delivered.error), /requires PASS/);
    assert.equal(merges, 0);
    await tools.dispose();
  });

  it("serves the stateless authenticated review endpoint without creating a job", async () => {
    const reviewTarget = target();
    const bus = createBus(() => reviewTarget, () => {});
    setBusInstance(bus);
    const payload = JSON.stringify({
      projectId: reviewTarget.projectId,
      repoPath: repoDir,
      branch: reviewTarget.branch,
      prNumber: reviewTarget.prNumber,
    });
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(payload);
      },
    } as never;
    let statusCode = 200;
    let responseBody = "";
    const response = {
      writeHead(code: number) { statusCode = code; },
      setHeader() {},
      end(data: string) { responseBody = data; },
    } as never;

    const handled = await handleActionRoutes({
      req: request,
      res: response,
      pathname: "/api/actions/review",
      url: new URL("http://localhost/api/actions/review"),
      auth: { userId: "user-1", username: "tester" },
    }, { allowedDirs: [repoDir] });

    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    assert.deepEqual(JSON.parse(responseBody), {
      ok: true,
      authoritative: true,
      status: "PASS",
      summary: "Exact target reviewed",
      defects: [],
    });
    assert.deepEqual(bus.getJobs(reviewTarget.projectId, repoDir, "user-1"), []);
  });
});

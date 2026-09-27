import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ACTIONS_BASE_BRANCH,
  branchScopeError,
  buildPrCreateArgs,
  buildPrMergeArgs,
  checkFeatureBranchScope,
  parseOpenPullRequest,
  unsupportedPrMergeFlags,
} from "../../server/actions/pipeline.js";

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
}

function commit(cwd: string, message: string): void {
  fs.writeFileSync(path.join(cwd, "file.txt"), message);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
}

function revParse(cwd: string, ref: string): string {
  const res = spawnSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git rev-parse ${ref} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function initRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pr-scope-"));
  git(cwd, "init", "-b", "dev");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  commit(cwd, "base");
  return cwd;
}

describe("Actions PR creation arguments", () => {
  it("targets the dev base branch explicitly", () => {
    const args = buildPrCreateArgs({
      title: "feat(web): something",
      body: "Closes #1",
      labels: ["feat"],
      baseBranch: ACTIONS_BASE_BRANCH,
    });

    const baseIndex = args.indexOf("--base");
    assert.notEqual(baseIndex, -1, `expected --base in ${args.join(" ")}`);
    assert.equal(args[baseIndex + 1], "dev");
  });

  it("passes the head branch so a switched workspace cannot redirect the pull request", () => {
    const args = buildPrCreateArgs({
      title: "feat(web): something",
      body: "Closes #1",
      labels: ["feat"],
      baseBranch: ACTIONS_BASE_BRANCH,
      headBranch: "codex/issue-7",
    });

    const headIndex = args.indexOf("--head");
    assert.notEqual(headIndex, -1, `expected --head in ${args.join(" ")}`);
    assert.equal(args[headIndex + 1], "codex/issue-7");
  });

  it("omits --head when no branch is supplied", () => {
    const args = buildPrCreateArgs({
      title: "feat(web): something",
      body: "Closes #1",
      labels: ["feat"],
      baseBranch: ACTIONS_BASE_BRANCH,
    });

    assert.equal(args.includes("--head"), false);
  });
});

describe("Actions existing pull request lookup", () => {
  it("reads the first open pull request for a branch", () => {
    assert.deepEqual(parseOpenPullRequest('[{"number":439,"url":"https://github.com/Andy963/ads/pull/439"}]'), {
      prNumber: 439,
      prUrl: "https://github.com/Andy963/ads/pull/439",
    });
  });

  it("returns nothing for an empty, malformed, or unusable payload", () => {
    assert.equal(parseOpenPullRequest("[]"), null);
    assert.equal(parseOpenPullRequest("not json"), null);
    assert.equal(parseOpenPullRequest('[{"number":0,"url":"https://example.test/pull/0"}]'), null);
    assert.equal(parseOpenPullRequest('[{"number":439}]'), null);
  });
});

describe("Actions PR merge arguments", () => {
  it("targets the requested pull request and squashes", () => {
    assert.deepEqual(buildPrMergeArgs(428), ["pr", "merge", "428", "--squash"]);
  });

  it("passes no flag that gh pr merge would reject", () => {
    // gh exits non-zero on an unknown flag, so a rejected flag aborts the merge
    // before any state change. `--yes` and `--delete-branch=false` both broke this.
    assert.deepEqual(unsupportedPrMergeFlags(buildPrMergeArgs(428)), []);
  });

  it("detects an unsupported flag rather than passing it through", () => {
    assert.deepEqual(unsupportedPrMergeFlags(["pr", "merge", "428", "--squash", "--yes"]), ["--yes"]);
  });
});

describe("Actions feature branch scope", () => {
  it("accepts a branch that stacks commits on the recorded base commit", () => {
    const cwd = initRepo();
    const anchor = revParse(cwd, "dev");
    git(cwd, "checkout", "-b", "codex/issue-1");
    commit(cwd, "job work");

    assert.equal(checkFeatureBranchScope(cwd, "dev", "codex/issue-1", anchor), null);
  });

  it("accepts the branch after the base branch moved on", () => {
    // The base advancing after the branch was cut is normal, and the old check
    // rejected it with a message claiming the branch carried foreign commits.
    const cwd = initRepo();
    const anchor = revParse(cwd, "dev");
    git(cwd, "checkout", "-b", "codex/issue-1");
    commit(cwd, "job work");
    git(cwd, "checkout", "dev");
    commit(cwd, "dev moved on");

    assert.equal(checkFeatureBranchScope(cwd, "dev", "codex/issue-1", anchor), null);
  });

  it("rejects a branch carrying history from another line", () => {
    const cwd = initRepo();
    git(cwd, "checkout", "-b", "other");
    commit(cwd, "unrelated");
    git(cwd, "checkout", "dev");
    commit(cwd, "dev moved on");
    const anchor = revParse(cwd, "dev");

    const error = checkFeatureBranchScope(cwd, "dev", "other", anchor);
    assert.ok(error, "expected the branch to be rejected");
    assert.match(error, /does not descend from the 'dev' commit recorded when the job started/);
    assert.match(error, /unrelated to this job/);
  });

  it("skips the check for jobs with no recorded base commit", () => {
    const cwd = initRepo();
    git(cwd, "checkout", "-b", "other");
    commit(cwd, "unrelated");
    git(cwd, "checkout", "dev");
    commit(cwd, "dev moved on");

    assert.equal(checkFeatureBranchScope(cwd, "dev", "other", null), null);
  });

  it("skips the check when the recorded base commit no longer exists", () => {
    const cwd = initRepo();
    git(cwd, "checkout", "-b", "codex/issue-1");
    commit(cwd, "job work");

    assert.equal(checkFeatureBranchScope(cwd, "dev", "codex/issue-1", "0".repeat(40)), null);
  });

  it("reports a missing base branch instead of opening a pull request", () => {
    const cwd = initRepo();
    assert.match(checkFeatureBranchScope(cwd, "no-such-base", "dev", revParse(cwd, "dev")) ?? "", /could not be resolved/);
  });

  it("passes when the merge base equals the recorded base commit", () => {
    assert.equal(
      branchScopeError({ baseBranch: "dev", branch: "b", expectedBaseSha: "abc", mergeBaseSha: "abc" }),
      null,
    );
  });
});

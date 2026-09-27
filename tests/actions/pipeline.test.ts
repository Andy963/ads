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
  it("accepts a branch that stacks commits on the base tip", () => {
    const cwd = initRepo();
    git(cwd, "checkout", "-b", "codex/issue-1");
    commit(cwd, "job work");

    assert.equal(checkFeatureBranchScope(cwd, "dev", "codex/issue-1"), null);
  });

  it("rejects a branch carrying history from another line", () => {
    const cwd = initRepo();
    git(cwd, "checkout", "-b", "other");
    commit(cwd, "unrelated");
    git(cwd, "checkout", "dev");
    commit(cwd, "dev moved on");

    const error = checkFeatureBranchScope(cwd, "dev", "other");
    assert.ok(error, "expected the branch to be rejected");
    assert.match(error, /does not descend from 'dev'/);
    assert.match(error, /unrelated to this job/);
  });

  it("reports a missing base branch instead of opening a pull request", () => {
    const cwd = initRepo();
    assert.match(checkFeatureBranchScope(cwd, "no-such-base", "dev") ?? "", /could not be resolved/);
  });

  it("passes when the merge base equals the base tip", () => {
    assert.equal(
      branchScopeError({ baseBranch: "dev", branch: "b", baseSha: "abc", mergeBaseSha: "abc" }),
      null,
    );
  });
});

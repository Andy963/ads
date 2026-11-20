import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ACTIONS_BASE_BRANCH,
  buildPrMergeArgs,
  deleteReviewedFeatureBranch,
  mergeAndCleanupPipeline,
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
  git(cwd, "init", "-b", ACTIONS_BASE_BRANCH);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  commit(cwd, "base");
  return cwd;
}

describe("Actions PR merge arguments", () => {
  it("squashes the requested pull request and pins the reviewed head", () => {
    assert.deepEqual(buildPrMergeArgs(428, "rev-1"), ["pr", "merge", "428", "--squash", "--match-head-commit", "rev-1"]);
  });

  it("omits the head pin only when no reviewed head is known", () => {
    assert.deepEqual(buildPrMergeArgs(428), ["pr", "merge", "428", "--squash"]);
  });
});

describe("Actions reviewed PR delivery", () => {
  it("refuses delivery when the pull request base commit changed after review", () => {
    const cwd = initRepo();
    git(cwd, "checkout", "-b", "feature");
    commit(cwd, "reviewed");
    const reviewedHead = revParse(cwd, "HEAD");

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-gh-fixture-"));
    const ghPath = path.join(binDir, "gh");
    const previousPath = process.env.PATH;
    fs.writeFileSync(ghPath, "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"OPEN\",\"mergedAt\":null,\"baseRefName\":\"dev\",\"baseRefOid\":\"changed-base\",\"headRefOid\":\"" + reviewedHead + "\"}'\n");
    fs.chmodSync(ghPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const result = mergeAndCleanupPipeline({
        cwd,
        prNumber: 42,
        branch: "feature",
        baseBranch: ACTIONS_BASE_BRANCH,
        expectedHead: reviewedHead,
        expectedBaseSha: revParse(cwd, ACTIONS_BASE_BRANCH),
      });
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /reviewed head, base, or base commit/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("preserves new local and remote commits after partial reviewed delivery", () => {
    const cwd = initRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ads-reviewed-remote-"));
    git(remote, "init", "--bare");
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "checkout", "-b", "feature");
    commit(cwd, "reviewed");
    const reviewed = revParse(cwd, "HEAD");
    git(cwd, "push", "origin", "feature");
    commit(cwd, "unreviewed");
    const advanced = revParse(cwd, "HEAD");
    git(cwd, "push", "origin", "feature");
    git(cwd, "checkout", ACTIONS_BASE_BRANCH);
    assert.match(deleteReviewedFeatureBranch(cwd, "feature", reviewed, true)!, /preserved/);
    assert.equal(revParse(cwd, "feature"), advanced);
    assert.equal(revParse(remote, "feature"), advanced);
    assert.equal(mergeAndCleanupPipeline({ cwd, branch: "feature", expectedHead: reviewed, prNumber: 42 }).success, false);
    assert.equal(revParse(cwd, "feature"), advanced);
  });
});

describe("Actions reviewed branch cleanup", () => {
  it("conditionally deletes reviewed refs and tolerates already absent refs", () => {
    const cwd = initRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ads-reviewed-remote-"));
    git(remote, "init", "--bare");
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "branch", "feature");
    git(cwd, "push", "origin", "feature");
    const head = revParse(cwd, "feature");
    assert.equal(deleteReviewedFeatureBranch(cwd, "feature", head, true), null);
    assert.equal(deleteReviewedFeatureBranch(cwd, "feature", head, true), null);
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "refs/heads/feature"], { cwd }).status, 0);
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "refs/heads/feature"], { cwd: remote }).status, 0);
  });
});

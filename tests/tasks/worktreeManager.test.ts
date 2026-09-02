import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskWorktreeManager } from "../../server/tasks/worktreeManager.js";

describe("tasks/worktreeManager", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-worktree-manager-"));
    childProcess.execFileSync("git", ["init", "-q", workspaceRoot]);
    childProcess.execFileSync("git", ["-C", workspaceRoot, "config", "user.email", "test@example.com"]);
    childProcess.execFileSync("git", ["-C", workspaceRoot, "config", "user.name", "ADS Test"]);
    fs.writeFileSync(path.join(workspaceRoot, "base.txt"), "base\n", "utf8");
    childProcess.execFileSync("git", ["-C", workspaceRoot, "add", "base.txt"]);
    childProcess.execFileSync("git", ["-C", workspaceRoot, "commit", "-qm", "base"]);
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("creates unique clean worktrees and cleans them without touching the shared checkout", () => {
    const manager = new TaskWorktreeManager({ workspaceRoot });
    const first = manager.prepare("task-a", "run-a");
    const second = manager.prepare("task-a", "run-b");

    assert.notEqual(first.worktreeDir, second.worktreeDir);
    assert.notEqual(first.branchName, second.branchName);
    assert.equal(manager.collectChangedPaths(first).length, 0);
    assert.equal(manager.collectChangedPaths(second).length, 0);

    fs.writeFileSync(path.join(first.worktreeDir, "first.txt"), "first\n", "utf8");
    fs.writeFileSync(path.join(second.worktreeDir, "second.txt"), "second\n", "utf8");
    assert.deepEqual(manager.collectChangedPaths(first), ["first.txt"]);
    assert.deepEqual(manager.collectChangedPaths(second), ["second.txt"]);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "first.txt")), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "second.txt")), false);

    assert.equal(manager.cleanup(first).status, "cleaned");
    assert.equal(manager.cleanup(second).status, "cleaned");
    assert.equal(fs.existsSync(first.worktreeDir), false);
    assert.equal(fs.existsSync(second.worktreeDir), false);
  });

  it("refuses cleanup paths outside the managed directory", () => {
    const manager = new TaskWorktreeManager({ workspaceRoot });
    const result = manager.cleanup({
      workspaceRoot,
      worktreeDir: path.join(workspaceRoot, "base.txt"),
      branchName: "ads/task/invalid",
      baseHead: "HEAD",
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /outside the managed directory/);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "base.txt"), "utf8"), "base\n");
  });
});

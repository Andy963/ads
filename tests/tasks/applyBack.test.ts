import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyTaskRunChanges } from "../../server/tasks/applyBack.js";
import { runCommand } from "../../server/utils/commandRunner.js";

async function git(cwd: string, args: string[]) {
  const res = await runCommand({ cmd: "git", args, cwd, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`);
  }
  return res.stdout.trim();
}

async function initRepo(workspaceRoot: string): Promise<string> {
  await git(workspaceRoot, ["init"]);
  await git(workspaceRoot, ["config", "user.name", "t"]);
  await git(workspaceRoot, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(workspaceRoot, "first.txt"), "one\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "second.txt"), "two\n", "utf8");
  await git(workspaceRoot, ["add", "-A"]);
  await git(workspaceRoot, ["commit", "-m", "init"]);
  return await git(workspaceRoot, ["rev-parse", "HEAD"]);
}

describe("tasks/applyBack", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-apply-back-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("rolls back workspace mutations when apply-back fails mid-copy", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    const worktreeDir = path.join(tmpDir, "repo-worktree");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);
    await git(workspaceRoot, ["worktree", "add", "-b", "task-run-1", worktreeDir, baseHead]);

    fs.writeFileSync(path.join(worktreeDir, "first.txt"), "one changed\n", "utf8");
    fs.writeFileSync(path.join(worktreeDir, "second.txt"), "two changed\n", "utf8");

    const originalCpSync = fs.cpSync;
    let sawWorkspaceWrite = false;
    let injectedFailure = false;
    (fs as typeof import("node:fs")).cpSync = ((src: fs.PathLike, dest: fs.PathLike, options?: fs.CopySyncOptions) => {
      const destPath = String(dest);
      if (destPath === path.join(workspaceRoot, "second.txt") && !injectedFailure) {
        injectedFailure = true;
        throw new Error("disk full");
      }
      if (destPath.startsWith(workspaceRoot + path.sep)) {
        sawWorkspaceWrite = true;
      }
      return originalCpSync(src, dest, options);
    }) as typeof fs.cpSync;

    try {
      const result = await applyTaskRunChanges({
        workspaceRoot,
        worktreeDir,
        baseHead,
      });

      assert.equal(result.status, "failed");
      assert.match(result.message ?? "", /disk full/);
      assert.equal(sawWorkspaceWrite, true);
      assert.equal(fs.readFileSync(path.join(workspaceRoot, "first.txt"), "utf8"), "one\n");
      assert.equal(fs.readFileSync(path.join(workspaceRoot, "second.txt"), "utf8"), "two\n");
    } finally {
      (fs as typeof import("node:fs")).cpSync = originalCpSync;
    }
  });
});

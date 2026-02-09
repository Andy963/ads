import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../src/utils/commandRunner.js";
import { stageSafeBootstrapChanges } from "../../src/bootstrap/gitCommitter.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function git(cwd: string, args: string[]) {
  const res = await runCommand({ cmd: "git", args, cwd, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`);
  }
  return res.stdout;
}

test("stages only safe changes (skips forbidden dirs, large files, and binaries)", async () => {
  const dir = tmpDir("ads-bootstrap-commit-");
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["config", "user.email", "t@t"]);

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.txt"), "hello\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "init"]);

  fs.writeFileSync(path.join(dir, "src", "a.txt"), "hello world\n", "utf8");

  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "x", "ignored.txt"), "nope", "utf8");

  const largePath = path.join(dir, "big.txt");
  fs.writeFileSync(largePath, "x".repeat(2 * 1024 * 1024), "utf8");

  const binPath = path.join(dir, "bin.dat");
  fs.writeFileSync(binPath, Buffer.from([0, 1, 2, 3, 0, 4, 5]));

  const outcome = await stageSafeBootstrapChanges(dir, { runCommand });
  assert.deepEqual(outcome.staged, ["src/a.txt"]);
  assert.ok(outcome.skipped.some((s) => s.path === "big.txt" && s.reason.startsWith("too_large:")) || outcome.skipped.some((s) => s.reason.startsWith("too_large:")));
  assert.ok(outcome.skipped.some((s) => s.path === "bin.dat" && s.reason === "binary_file"));
  assert.ok(outcome.skipped.some((s) => s.path === "node_modules/" && s.reason === "forbidden_path"));

  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  assert.equal(staged.trim(), "src/a.txt");
});

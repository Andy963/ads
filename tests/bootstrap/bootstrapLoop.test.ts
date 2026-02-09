import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../src/utils/commandRunner.js";
import { runBootstrapLoop } from "../../src/bootstrap/bootstrapLoop.js";
import type { BootstrapAgentRunner } from "../../src/bootstrap/agentRunner.js";

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

test("bootstrap loop iterates until lint+test pass and creates a commit", async () => {
  const repoDir = tmpDir("ads-bootstrap-src-");
  const stateDir = tmpDir("ads-bootstrap-state-");

  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "t"]);
  await git(repoDir, ["config", "user.email", "t@t"]);

  fs.writeFileSync(path.join(repoDir, "value.txt"), "bad\n", "utf8");
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-m", "init"]);

  const agentRunner: BootstrapAgentRunner = {
    reset() {},
    async runIteration(args) {
      fs.writeFileSync(path.join(args.cwd, "value.txt"), "ok\n", "utf8");
      return { response: "updated", usage: null };
    },
  };

  const checkScript = "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt','utf8').trim()==='ok'?0:1);";

  const result = await runBootstrapLoop(
    {
      project: { kind: "local_path", value: repoDir },
      goal: "Update value.txt to ok",
      maxIterations: 3,
      allowInstallDeps: false,
      requireHardSandbox: false,
      sandbox: { backend: "none" },
      recipe: {
        version: 1,
        install: [],
        lint: [{ cmd: "node", args: ["-e", checkScript], timeoutMs: 10_000 }],
        test: [{ cmd: "node", args: ["-e", checkScript], timeoutMs: 10_000 }],
        env: { CI: "1" },
      },
      commit: { enabled: true, messageTemplate: "bootstrap: ${goal}" },
      worktree: { branchPrefix: "bootstrap" },
      allowNetwork: true,
    },
    { agentRunner, stateDir },
  );

  assert.equal(result.ok, true);
  assert.equal(result.iterations, 1);
  assert.ok(result.finalCommit && result.finalCommit.length > 0);
  assert.ok(fs.existsSync(result.lastReportPath));

  const originalDiff = await git(repoDir, ["diff"]);
  assert.equal(originalDiff.trim(), "");
});

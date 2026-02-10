import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../src/utils/commandRunner.js";
import { runBootstrapLoop } from "../../src/bootstrap/bootstrapLoop.js";
import type { BootstrapAgentRunner } from "../../src/bootstrap/agentRunner.js";
import type { BootstrapReviewerRunner } from "../../src/bootstrap/review/reviewerRunner.js";

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

test("bootstrap loop runs review gate after verification and blocks commit until approved", async () => {
  const repoDir = tmpDir("ads-bootstrap-src-");
  const stateDir = tmpDir("ads-bootstrap-state-");

  await git(repoDir, ["init"]);
  await git(repoDir, ["config", "user.name", "t"]);
  await git(repoDir, ["config", "user.email", "t@t"]);

  fs.writeFileSync(path.join(repoDir, "value.txt"), "bad\n", "utf8");
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-m", "init"]);

  let agentCalls = 0;
  const agentRunner: BootstrapAgentRunner = {
    reset() {},
    async runIteration(args) {
      agentCalls += 1;
      if (agentCalls === 1) {
        fs.writeFileSync(path.join(args.cwd, "value.txt"), "ok\n", "utf8");
        return { response: "updated", usage: null };
      }
      return {
        response: JSON.stringify(
          {
            responses: [{ title: "Use ok value", status: "fixed", details: "Updated value.txt to ok" }],
            questionsAnswered: [],
          },
          null,
          2,
        ),
        usage: null,
      };
    },
  };

  let reviewCalls = 0;
  const reviewerRunner: BootstrapReviewerRunner = {
    async runReview() {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          response: JSON.stringify(
            {
              approve: false,
              riskLevel: "medium",
              blockingIssues: [
                {
                  title: "Use ok value",
                  file: "value.txt",
                  rationale: "Bootstrap goal requires value.txt to be ok",
                  suggestedFix: "Update value.txt to contain ok",
                },
              ],
              nonBlockingSuggestions: [],
              followUpVerification: [],
              questions: [],
            },
            null,
            2,
          ),
          usage: null,
        };
      }
      return {
        response: JSON.stringify(
          {
            approve: true,
            riskLevel: "low",
            blockingIssues: [],
            nonBlockingSuggestions: [],
            followUpVerification: [],
            questions: [],
          },
          null,
          2,
        ),
        usage: null,
      };
    },
  };

  const checkScript = "const fs = require('node:fs'); process.exit(fs.readFileSync('value.txt','utf8').trim()==='ok'?0:1);";

  const result = await runBootstrapLoop(
    {
      project: { kind: "local_path", value: repoDir },
      goal: "Update value.txt to ok",
      maxIterations: 5,
      allowInstallDeps: false,
      requireHardSandbox: false,
      sandbox: { backend: "none" },
      review: { enabled: true, maxRounds: 2 },
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
    { agentRunner, reviewerRunner, stateDir },
  );

  assert.equal(result.ok, true);
  assert.equal(result.iterations, 2);
  assert.equal(agentCalls, 2);
  assert.equal(reviewCalls, 2);
  assert.ok(result.finalCommit && result.finalCommit.length > 0);
  assert.ok(fs.existsSync(result.lastReportPath));

  const originalDiff = await git(repoDir, ["diff"]);
  assert.equal(originalDiff.trim(), "");
});

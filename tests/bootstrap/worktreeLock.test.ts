import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { runCommand } from "../../src/utils/commandRunner.js";

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

type WorkerReady = { type: "ready" };
type WorkerResult = { type: "result"; ok: true; worktree: { projectId: string; runId: string; bootstrapRoot: string; worktreeDir: string } } | { type: "result"; ok: false; error: string };

function spawnWorktreeWorker(payload: { projectPath: string; stateDir: string; branchPrefix: string }) {
  const url = new URL("./worktreeWorker.mjs", import.meta.url);
  const worker = new Worker(url, { workerData: payload, execArgv: [] });

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let resultResolve!: (value: WorkerResult) => void;
  let resultReject!: (error: Error) => void;
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });

  worker.on("message", (msg: WorkerReady | WorkerResult) => {
    if (msg.type === "ready") {
      readyResolve();
      return;
    }
    if (msg.type === "result") {
      resultResolve(msg);
    }
  });

  worker.once("error", (error) => {
    readyReject(error);
    resultReject(error);
  });
  worker.once("exit", (code) => {
    if (code === 0) {
      return;
    }
    const error = new Error(`worker exited with code ${code}`);
    readyReject(error);
    resultReject(error);
  });

  return {
    worker,
    ready,
    result,
    start() {
      worker.postMessage({ type: "start" });
    },
  };
}

test("prepareBootstrapWorktree serializes repo operations across workers", { timeout: 120_000 }, async () => {
  const sourceRepoDir = tmpDir("ads-bootstrap-src-");
  const stateDir = tmpDir("ads-bootstrap-state-");

  await git(sourceRepoDir, ["init"]);
  await git(sourceRepoDir, ["config", "user.name", "t"]);
  await git(sourceRepoDir, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(sourceRepoDir, "hello.txt"), "hello\n", "utf8");
  await git(sourceRepoDir, ["add", "-A"]);
  await git(sourceRepoDir, ["commit", "-m", "init"]);

  const worker1 = spawnWorktreeWorker({ projectPath: sourceRepoDir, stateDir, branchPrefix: "bootstrap" });
  const worker2 = spawnWorktreeWorker({ projectPath: sourceRepoDir, stateDir, branchPrefix: "bootstrap" });

  await Promise.all([worker1.ready, worker2.ready]);
  worker1.start();
  worker2.start();

  const [res1, res2] = await Promise.all([worker1.result, worker2.result]);
  if (!res1.ok) {
    assert.fail(res1.error);
  }
  if (!res2.ok) {
    assert.fail(res2.error);
  }

  assert.equal(res1.worktree.projectId, res2.worktree.projectId);
  assert.notEqual(res1.worktree.runId, res2.worktree.runId);
  assert.notEqual(res1.worktree.worktreeDir, res2.worktree.worktreeDir);

  assert.ok(fs.existsSync(res1.worktree.worktreeDir));
  assert.ok(fs.existsSync(res2.worktree.worktreeDir));

  const lockDir = path.join(res1.worktree.bootstrapRoot, ".locks", "repo.lock");
  assert.equal(fs.existsSync(lockDir), false);
});

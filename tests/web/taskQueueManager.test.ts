import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { runCommand } from "../../server/utils/commandRunner.js";
import { createTaskQueueManager } from "../../server/web/server/taskQueue/manager.js";

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
  fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello\n", "utf8");
  await git(workspaceRoot, ["add", "-A"]);
  await git(workspaceRoot, ["commit", "-m", "init"]);
  return await git(workspaceRoot, ["rev-parse", "HEAD"]);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("web/taskQueue manager workspace resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-queue-manager-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createManager(allowedDirs: string[]) {
    return createTaskQueueManager({
      workspaceRoot: tmpDir,
      allowedDirs,
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
    });
  }

  it("resolves nested workspace paths to the shared workspace root", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const nestedDir = path.join(tmpDir, "packages", "worker");
    fs.mkdirSync(nestedDir, { recursive: true });

    const manager = createManager([tmpDir]);
    const resolved = manager.resolveTaskWorkspaceRoot(
      new URL(`http://localhost/api/task-queue/status?workspace=${encodeURIComponent(nestedDir)}`),
    );

    assert.equal(resolved, path.resolve(tmpDir));
  });

  it("rejects nested workspace paths when the detected workspace root is outside the allow list", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const allowedRoot = path.join(tmpDir, "sandbox");
    const nestedDir = path.join(allowedRoot, "workspace");
    fs.mkdirSync(nestedDir, { recursive: true });

    const manager = createManager([allowedRoot]);

    assert.throws(
      () => manager.resolveTaskWorkspaceRoot(new URL(`http://localhost/api/task-queue/status?workspace=${encodeURIComponent(nestedDir)}`)),
      /Workspace is not allowed/,
    );
  });
});

describe("web/taskQueue manager isolated review apply-back", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-queue-review-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    process.env.ADS_TASK_QUEUE_SESSION_TIMEOUT_MS = "0";
    process.env.ADS_TASK_QUEUE_SESSION_CLEANUP_INTERVAL_MS = "0";
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("builds review snapshots from baseHead diffs and serializes passed apply-back through the workspace lock", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    const worktreeDir = path.join(tmpDir, "repo-worktree");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);
    await git(workspaceRoot, ["worktree", "add", "-b", "task-run-1", worktreeDir, baseHead]);
    fs.writeFileSync(path.join(worktreeDir, "note.txt"), "committed\n", "utf8");
    await git(worktreeDir, ["add", "note.txt"]);
    await git(worktreeDir, ["commit", "-m", "change"]);
    const endHead = await git(worktreeDir, ["rev-parse", "HEAD"]);

    let lockCalls = 0;
    const reviewPrompts: string[] = [];
    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => {
            lockCalls += 1;
            return await fn();
          },
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          return {
            setWorkingDirectory() {},
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent(_: string, prompt: string) {
              reviewPrompts.push(prompt);
              return { response: JSON.stringify({ verdict: "passed", conclusion: "ship it" }) };
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "isolated review", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir,
        branchName: "task-run-1",
        baseHead,
        endHead,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:changed_paths",
        content: JSON.stringify({ paths: ["note.txt"] }),
        createdAt: now,
      },
      now,
    );
    const completedTask = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done", completedAt: now }, now);
    ctx.taskQueue.emit("task:completed", { task: completedTask });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "passed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const snapshot = ctx.reviewStore.getSnapshot(String(updatedTask?.reviewSnapshotId ?? ""));
    const latestRun = ctx.taskStore.getLatestTaskRun(task.id);

    assert.equal(reviewPrompts.length, 1);
    assert.deepEqual(snapshot?.changedFiles, ["note.txt"]);
    assert.match(snapshot?.patch?.diff ?? "", /committed/);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "note.txt"), "utf8"), "committed\n");
    assert.equal(latestRun?.applyStatus, "applied");
    assert.equal(lockCalls, 1);
  });

  it("marks rejected isolated runs as skipped instead of leaving apply-back pending", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          return {
            setWorkingDirectory() {},
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent() {
              return { response: JSON.stringify({ verdict: "rejected", conclusion: "needs work" }) };
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "isolated reject", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:changed_paths",
        content: JSON.stringify({ paths: ["note.txt"] }),
        createdAt: now,
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:workspace_patch",
        content: JSON.stringify({
          paths: ["note.txt"],
          patch: {
            files: [{ path: "note.txt", added: 0, removed: 0 }],
            diff: "diff --git a/note.txt b/note.txt\n",
            truncated: false,
          },
          createdAt: now,
        }),
        createdAt: now,
      },
      now,
    );
    const completedTask = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done", completedAt: now }, now);
    ctx.taskQueue.emit("task:completed", { task: completedTask });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "rejected");

    const latestRun = ctx.taskStore.getLatestTaskRun(task.id);
    assert.equal(latestRun?.applyStatus, "skipped");
  });

  it("fails closed when review snapshot patch is missing", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);
    let reviewInvocations = 0;

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          return {
            setWorkingDirectory() {},
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent() {
              reviewInvocations += 1;
              return { response: JSON.stringify({ verdict: "passed", conclusion: "should not run" }) };
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "missing patch", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:changed_paths",
        content: JSON.stringify({ paths: ["note.txt"] }),
        createdAt: now,
      },
      now,
    );
    const completedTask = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done", completedAt: now }, now);
    ctx.taskQueue.emit("task:completed", { task: completedTask });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const updatedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(reviewInvocations, 0);
    assert.equal(updatedTask?.reviewConclusion, "review_snapshot_patch_missing");
    assert.equal(updatedTask?.status, "failed");
    assert.equal(updatedRun?.captureStatus, "failed");
    assert.equal(updatedRun?.applyStatus, "failed");
  });

  it("applies review results to the snapshot-bound run instead of the latest run", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    const oldWorktreeDir = path.join(tmpDir, "repo-worktree-old");
    const newWorktreeDir = path.join(tmpDir, "repo-worktree-new");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);
    await git(workspaceRoot, ["worktree", "add", "-b", "task-run-old", oldWorktreeDir, baseHead]);
    fs.writeFileSync(path.join(oldWorktreeDir, "note.txt"), "old run\n", "utf8");
    await git(oldWorktreeDir, ["add", "note.txt"]);
    await git(oldWorktreeDir, ["commit", "-m", "old"]);
    const oldEndHead = await git(oldWorktreeDir, ["rev-parse", "HEAD"]);

    await git(workspaceRoot, ["worktree", "add", "-b", "task-run-new", newWorktreeDir, baseHead]);
    fs.writeFileSync(path.join(newWorktreeDir, "note.txt"), "new run\n", "utf8");
    await git(newWorktreeDir, ["add", "note.txt"]);
    await git(newWorktreeDir, ["commit", "-m", "new"]);
    const newEndHead = await git(newWorktreeDir, ["rev-parse", "HEAD"]);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          return {
            setWorkingDirectory() {},
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent() {
              return { response: JSON.stringify({ verdict: "passed", conclusion: "ship" }) };
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "bound run", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const oldRun = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: oldWorktreeDir,
        branchName: "task-run-old",
        baseHead,
        endHead: oldEndHead,
        status: "completed",
        captureStatus: "ok",
        applyStatus: "pending",
      },
      now,
    );
    const newRun = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: newWorktreeDir,
        branchName: "task-run-new",
        baseHead,
        endHead: newEndHead,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now + 1,
    );
    const snapshot = ctx.reviewStore.createSnapshot(
      {
        taskId: task.id,
        taskRunId: oldRun.id,
        specRef: null,
        patch: {
          files: [{ path: "note.txt", added: 1, removed: 1 }],
          diff: "diff --git a/note.txt b/note.txt\n-old\n+old run\n",
          truncated: false,
        },
        changedFiles: ["note.txt"],
        lintSummary: "",
        testSummary: "",
      },
      now,
    );
    ctx.taskStore.updateTask(
      task.id,
      { status: "completed", reviewRequired: true, reviewStatus: "pending", reviewSnapshotId: snapshot.id, completedAt: now },
      now,
    );
    ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
    ctx.taskQueue.emit("task:completed", { task: ctx.taskStore.getTask(task.id)! });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "passed");

    const updatedOldRun = ctx.taskStore.getTaskRun(oldRun.id);
    const updatedNewRun = ctx.taskStore.getTaskRun(newRun.id);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "note.txt"), "utf8"), "old run\n");
    assert.equal(updatedOldRun?.applyStatus, "applied");
    assert.equal(updatedNewRun?.applyStatus, "pending");
  });

  it("runs the reviewer session inside the snapshot-bound worktree instead of the live workspace root", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    const worktreeDir = path.join(tmpDir, "repo-review-worktree");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);
    let sessionCwd = "";
    let workingDirectory = "";

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate(_: number, cwd: string) {
          sessionCwd = cwd;
          return {
            setWorkingDirectory(nextCwd: string) {
              workingDirectory = nextCwd;
            },
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent() {
              return { response: JSON.stringify({ verdict: "rejected", conclusion: "reviewed in worktree" }) };
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "review cwd", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir,
        branchName: "task-run-review",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "ok",
        applyStatus: "pending",
      },
      now,
    );
    const snapshot = ctx.reviewStore.createSnapshot(
      {
        taskId: task.id,
        taskRunId: run.id,
        specRef: null,
        patch: {
          files: [{ path: "note.txt", added: 1, removed: 0 }],
          diff: "diff --git a/note.txt b/note.txt\n+review\n",
          truncated: false,
        },
        changedFiles: ["note.txt"],
        lintSummary: "",
        testSummary: "",
      },
      now,
    );
    ctx.taskStore.updateTask(
      task.id,
      { status: "completed", reviewRequired: true, reviewStatus: "pending", reviewSnapshotId: snapshot.id, completedAt: now },
      now,
    );
    ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
    ctx.taskQueue.emit("task:completed", { task: ctx.taskStore.getTask(task.id)! });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "rejected");

    assert.equal(sessionCwd, worktreeDir);
    assert.equal(workingDirectory, worktreeDir);
  });

  it("fails closed when review snapshot creation throws", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          throw new Error("should not invoke reviewer");
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "snapshot create fail", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:changed_paths",
        content: JSON.stringify({ paths: ["note.txt"] }),
        createdAt: now,
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:workspace_patch",
        content: JSON.stringify({
          paths: ["note.txt"],
          patch: {
            files: [{ path: "note.txt", added: 0, removed: 0 }],
            diff: "diff --git a/note.txt b/note.txt\n",
            truncated: false,
          },
          createdAt: now,
        }),
        createdAt: now,
      },
      now,
    );
    ctx.reviewStore.createSnapshot = (() => {
      throw new Error("db_write_failed");
    }) as typeof ctx.reviewStore.createSnapshot;

    const completedTask = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done", completedAt: now }, now);
    ctx.taskQueue.emit("task:completed", { task: completedTask });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const updatedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(updatedTask?.status, "failed");
    assert.match(updatedTask?.reviewConclusion ?? "", /review_snapshot_create_failed:db_write_failed/);
    assert.equal(updatedRun?.captureStatus, "failed");
    assert.equal(updatedRun?.applyStatus, "failed");
    assert.deepEqual(ctx.reviewStore.listQueueItems(), []);
  });

  it("fails closed when review queue enqueue throws", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          throw new Error("should not invoke reviewer");
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "enqueue fail", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "pending",
        applyStatus: "pending",
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:changed_paths",
        content: JSON.stringify({ paths: ["note.txt"] }),
        createdAt: now,
      },
      now,
    );
    ctx.taskStore.saveContext(
      task.id,
      {
        contextType: "artifact:workspace_patch",
        content: JSON.stringify({
          paths: ["note.txt"],
          patch: {
            files: [{ path: "note.txt", added: 0, removed: 0 }],
            diff: "diff --git a/note.txt b/note.txt\n",
            truncated: false,
          },
          createdAt: now,
        }),
        createdAt: now,
      },
      now,
    );
    ctx.reviewStore.enqueueReview = (() => {
      throw new Error("queue_write_failed");
    }) as typeof ctx.reviewStore.enqueueReview;

    const completedTask = ctx.taskStore.updateTask(task.id, { status: "completed", result: "done", completedAt: now }, now);
    ctx.taskQueue.emit("task:completed", { task: completedTask });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const updatedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(updatedTask?.status, "failed");
    assert.match(updatedTask?.reviewConclusion ?? "", /review_queue_enqueue_failed:queue_write_failed/);
    assert.equal(updatedRun?.captureStatus, "ok");
    assert.equal(updatedRun?.applyStatus, "failed");
    assert.deepEqual(ctx.reviewStore.listQueueItems(), []);
  });

  it("closes applyStatus when the reviewer invocation fails", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          return {
            setWorkingDirectory() {},
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent() {
              throw new Error("reviewer_crashed");
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "invoke fail", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "ok",
        applyStatus: "pending",
      },
      now,
    );
    const snapshot = ctx.reviewStore.createSnapshot(
      {
        taskId: task.id,
        taskRunId: run.id,
        specRef: null,
        patch: {
          files: [{ path: "note.txt", added: 1, removed: 0 }],
          diff: "diff --git a/note.txt b/note.txt\n+boom\n",
          truncated: false,
        },
        changedFiles: ["note.txt"],
        lintSummary: "",
        testSummary: "",
      },
      now,
    );
    ctx.taskStore.updateTask(
      task.id,
      { status: "completed", reviewRequired: true, reviewStatus: "pending", reviewSnapshotId: snapshot.id, completedAt: now },
      now,
    );
    ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
    ctx.taskQueue.emit("task:completed", { task: ctx.taskStore.getTask(task.id)! });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const updatedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(updatedTask?.status, "failed");
    assert.equal(updatedRun?.applyStatus, "failed");
    assert.equal(updatedRun?.status, "failed");
  });

  it("closes applyStatus when the reviewer returns invalid verdict json", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          return {
            setWorkingDirectory() {},
            status() {
              return { ready: true };
            },
            getActiveAgentId() {
              return "reviewer";
            },
            async invokeAgent() {
              return { response: "{not-json" };
            },
          };
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "invalid json", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "ok",
        applyStatus: "pending",
      },
      now,
    );
    const snapshot = ctx.reviewStore.createSnapshot(
      {
        taskId: task.id,
        taskRunId: run.id,
        specRef: null,
        patch: {
          files: [{ path: "note.txt", added: 1, removed: 0 }],
          diff: "diff --git a/note.txt b/note.txt\n+boom\n",
          truncated: false,
        },
        changedFiles: ["note.txt"],
        lintSummary: "",
        testSummary: "",
      },
      now,
    );
    ctx.taskStore.updateTask(
      task.id,
      { status: "completed", reviewRequired: true, reviewStatus: "pending", reviewSnapshotId: snapshot.id, completedAt: now },
      now,
    );
    ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
    ctx.taskQueue.emit("task:completed", { task: ctx.taskStore.getTask(task.id)! });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const updatedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(updatedTask?.status, "failed");
    assert.match(updatedTask?.reviewConclusion ?? "", /invalid_review_verdict_json:/);
    assert.equal(updatedRun?.applyStatus, "failed");
    assert.equal(updatedRun?.status, "failed");
  });

  it("closes applyStatus when the queued snapshot can no longer be found", async () => {
    const workspaceRoot = path.join(tmpDir, "repo");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const baseHead = await initRepo(workspaceRoot);

    const manager = createTaskQueueManager({
      workspaceRoot,
      allowedDirs: [workspaceRoot],
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
      reviewSessionManager: {
        getOrCreate() {
          throw new Error("should not invoke reviewer");
        },
        dropSession() {},
      } as any,
      broadcastToReviewerSession: () => {},
      recordToReviewerHistories: () => {},
    });

    const ctx = manager.ensureTaskContext(workspaceRoot);
    const now = Date.now();
    const task = ctx.taskStore.createTask(
      { title: "missing snapshot", prompt: "review", model: "auto", executionIsolation: "required", reviewRequired: true },
      now,
    );
    const run = ctx.taskStore.createTaskRun(
      {
        taskId: task.id,
        executionIsolation: "required",
        workspaceRoot,
        worktreeDir: workspaceRoot,
        branchName: "task-run-1",
        baseHead,
        endHead: baseHead,
        status: "completed",
        captureStatus: "ok",
        applyStatus: "pending",
      },
      now,
    );
    const snapshot = ctx.reviewStore.createSnapshot(
      {
        taskId: task.id,
        taskRunId: run.id,
        specRef: null,
        patch: {
          files: [{ path: "note.txt", added: 1, removed: 0 }],
          diff: "diff --git a/note.txt b/note.txt\n+missing\n",
          truncated: false,
        },
        changedFiles: ["note.txt"],
        lintSummary: "",
        testSummary: "",
      },
      now,
    );
    const originalGetSnapshot = ctx.reviewStore.getSnapshot.bind(ctx.reviewStore);
    ctx.reviewStore.getSnapshot = ((snapshotId: string) => {
      if (snapshotId === snapshot.id) {
        return null;
      }
      return originalGetSnapshot(snapshotId);
    }) as typeof ctx.reviewStore.getSnapshot;
    ctx.taskStore.updateTask(
      task.id,
      { status: "completed", reviewRequired: true, reviewStatus: "pending", reviewSnapshotId: snapshot.id, completedAt: now },
      now,
    );
    ctx.reviewStore.enqueueReview({ taskId: task.id, snapshotId: snapshot.id }, now);
    ctx.taskQueue.emit("task:completed", { task: ctx.taskStore.getTask(task.id)! });

    await waitForCondition(() => ctx.taskStore.getTask(task.id)?.reviewStatus === "failed");

    const updatedTask = ctx.taskStore.getTask(task.id);
    const updatedRun = ctx.taskStore.getTaskRun(run.id);
    assert.equal(updatedTask?.status, "failed");
    assert.equal(updatedTask?.reviewConclusion, "snapshot_not_found");
    assert.equal(updatedRun?.applyStatus, "failed");
    assert.equal(updatedRun?.status, "failed");
  });
});

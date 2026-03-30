import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { OrchestratorTaskExecutor, persistTaskWorktreeReference } from "../../server/tasks/executor.js";
import { TaskStore } from "../../server/tasks/store.js";
import type { Task } from "../../server/tasks/types.js";
import { createAbortError } from "../../server/utils/abort.js";
import { runCommand } from "../../server/utils/commandRunner.js";

async function git(cwd: string, args: string[]) {
  const res = await runCommand({ cmd: "git", args, cwd, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git exited with code ${res.exitCode}`);
  }
  return res.stdout;
}

async function initRepo(workspaceRoot: string): Promise<void> {
  await git(workspaceRoot, ["init"]);
  await git(workspaceRoot, ["config", "user.name", "t"]);
  await git(workspaceRoot, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello\n", "utf8");
  await git(workspaceRoot, ["add", "-A"]);
  await git(workspaceRoot, ["commit", "-m", "init"]);
}

describe("tasks/executor artifacts", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-exec-artifacts-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
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

  it("injects previous workspace patch and records changed paths", async () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;
    store.saveContext(
      task.id,
      {
        contextType: "artifact:previous_workspace_patch",
        content: JSON.stringify({
          paths: ["src/a.ts"],
          patch: { files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+test\n", truncated: false },
          createdAt: Date.now(),
        }),
      },
      Date.now(),
    );

    let onEventHandler: ((ev: any) => void) | null = null;
    const seenPrompts: string[] = [];
    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent(handler: any) {
        onEventHandler = handler;
        return () => {
          onEventHandler = null;
        };
      },
      async invokeAgent(_: string, input: string) {
        seenPrompts.push(String(input));
        onEventHandler?.({
          phase: "tool",
          title: "file_change",
          detail: "",
          delta: null,
          raw: { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts" }] } },
        });
        return { response: "ok" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {});

    assert.ok(seenPrompts.length >= 1);
    assert.ok(seenPrompts[0]?.includes("```diff"));
    assert.ok(seenPrompts[0]?.includes("diff --git a/src/a.ts b/src/a.ts"));

    const contexts = store.getContext(task.id);
    const changed = contexts.filter((c) => c.contextType === "artifact:changed_paths");
    assert.equal(changed.length, 1);
    const payload = JSON.parse(changed[0]!.content) as { paths?: string[] };
    assert.deepEqual(payload.paths, ["src/a.ts"]);
  });

  it("preserves the full stored workspace patch when re-prompting", async () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;
    const tailMarker = "TAIL_MARKER_SHOULD_SURVIVE";
    const longDiff = `diff --git a/src/a.ts b/src/a.ts\n${"+x".repeat(2500)}\n${tailMarker}\n`;
    store.saveContext(
      task.id,
      {
        contextType: "artifact:previous_workspace_patch",
        content: JSON.stringify({
          paths: ["src/a.ts"],
          patch: { files: [{ path: "src/a.ts", added: 2501, removed: 0 }], diff: longDiff, truncated: false },
          createdAt: Date.now(),
        }),
      },
      Date.now(),
    );

    const prompts: string[] = [];
    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => undefined;
      },
      async invokeAgent(_: string, input: string) {
        prompts.push(String(input));
        return { response: "ok" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {});

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", new RegExp(tailMarker));
  });

  it("injects explicit reviewer artifact references only when present", async () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;
    store.saveContext(
      task.id,
      {
        contextType: "artifact:review_artifact_reference",
        content: JSON.stringify({
          reviewArtifactId: "artifact-1",
          snapshotId: "snapshot-1",
          taskId: "source-task",
          verdict: "analysis",
          scope: "reviewer",
          summaryText: "Use a guard clause.",
          responseText: "Use a guard clause before the expensive branch.",
        }),
      },
      Date.now(),
    );

    const prompts: string[] = [];
    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => undefined;
      },
      async invokeAgent(_: string, input: string) {
        prompts.push(String(input));
        return { response: "ok" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {});

    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /reviewArtifactId: artifact-1/);
    assert.match(prompts[0] ?? "", /snapshotId: snapshot-1/);
    assert.match(prompts[0] ?? "", /Use a guard clause before the expensive branch\./);
  });

  it("persists explicit worktree references for reviewer snapshot binding", () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;

    persistTaskWorktreeReference(store, task.id, { worktreeDir: "/tmp/bootstrap-worktree", source: "bootstrap" }, 123);

    const contexts = store.getContext(task.id);
    const worktreeRef = contexts.find((context) => context.contextType === "artifact:worktree_reference");
    assert.ok(worktreeRef);
    assert.deepEqual(JSON.parse(worktreeRef!.content), {
      worktreeDir: "/tmp/bootstrap-worktree",
      source: "bootstrap",
      createdAt: 123,
    });
  });

  it("runs required-isolation tasks inside a worktree and applies changes back", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpDir, "repo-"));
    await initRepo(workspaceRoot);

    const store = new TaskStore();
    const task = store.createTask({
      title: "isolated",
      prompt: "update note",
      model: "auto",
      executionIsolation: "required",
      reviewRequired: false,
    }) as Task;

    let workingDirectory = "";
    const orchestrator = {
      setModel() {},
      setWorkingDirectory(dir?: string) {
        workingDirectory = String(dir ?? "");
      },
      onEvent() {
        return () => {};
      },
      async invokeAgent() {
        fs.writeFileSync(path.join(workingDirectory, "note.txt"), "changed\n", "utf8");
        return { response: "done" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {});

    assert.notEqual(workingDirectory, workspaceRoot);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "note.txt"), "utf8"), "changed\n");

    const latestRun = store.getLatestTaskRun(task.id);
    assert.ok(latestRun);
    assert.equal(latestRun?.executionIsolation, "required");
    assert.equal(latestRun?.applyStatus, "applied");
    assert.equal(latestRun?.status, "completed");
    assert.ok(latestRun?.worktreeDir);
  });

  it("applies committed isolated changes back to the workspace", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpDir, "repo-"));
    await initRepo(workspaceRoot);

    const store = new TaskStore();
    const task = store.createTask({
      title: "isolated committed",
      prompt: "commit note update",
      model: "auto",
      executionIsolation: "required",
      reviewRequired: false,
    }) as Task;

    let workingDirectory = "";
    const orchestrator = {
      setModel() {},
      setWorkingDirectory(dir?: string) {
        workingDirectory = String(dir ?? "");
      },
      onEvent() {
        return () => {};
      },
      async invokeAgent() {
        fs.writeFileSync(path.join(workingDirectory, "note.txt"), "committed\n", "utf8");
        await git(workingDirectory, ["add", "note.txt"]);
        await git(workingDirectory, ["commit", "-m", "change"]);
        return { response: "done" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {});

    assert.notEqual(workingDirectory, workspaceRoot);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "note.txt"), "utf8"), "committed\n");

    const latestRun = store.getLatestTaskRun(task.id);
    assert.equal(latestRun?.applyStatus, "applied");
    assert.equal(latestRun?.status, "completed");
  });

  it("records committed isolated changes for review-required runs", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpDir, "repo-"));
    await initRepo(workspaceRoot);

    const store = new TaskStore();
    const task = store.createTask({
      title: "isolated review",
      prompt: "commit note update",
      model: "auto",
      executionIsolation: "required",
      reviewRequired: true,
    }) as Task;

    let workingDirectory = "";
    const orchestrator = {
      setModel() {},
      setWorkingDirectory(dir?: string) {
        workingDirectory = String(dir ?? "");
      },
      onEvent() {
        return () => {};
      },
      async invokeAgent() {
        fs.writeFileSync(path.join(workingDirectory, "note.txt"), "reviewed\n", "utf8");
        await git(workingDirectory, ["add", "note.txt"]);
        await git(workingDirectory, ["commit", "-m", "review"]);
        return { response: "done" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {});

    const contexts = store.getContext(task.id);
    const changed = contexts.filter((c) => c.contextType === "artifact:changed_paths");
    assert.equal(changed.length, 1);
    const payload = JSON.parse(changed[0]!.content) as { paths?: string[] };
    assert.deepEqual(payload.paths, ["note.txt"]);

    const latestRun = store.getLatestTaskRun(task.id);
    assert.equal(latestRun?.captureStatus, "pending");
    assert.equal(latestRun?.applyStatus, "pending");
  });

  it("closes pending sub-statuses when isolated execution fails", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpDir, "repo-"));
    await initRepo(workspaceRoot);

    const store = new TaskStore();
    const task = store.createTask({
      title: "isolated fail",
      prompt: "fail",
      model: "auto",
      executionIsolation: "required",
      reviewRequired: true,
    }) as Task;

    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => {};
      },
      async invokeAgent() {
        throw new Error("boom");
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot,
      autoModelOverride: "mock",
    });

    await assert.rejects(() => executor.execute(task, {}), /boom/);

    const latestRun = store.getLatestTaskRun(task.id);
    assert.equal(latestRun?.status, "failed");
    assert.equal(latestRun?.captureStatus, "failed");
    assert.equal(latestRun?.applyStatus, "failed");
  });

  it("closes pending sub-statuses when isolated execution is cancelled", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpDir, "repo-"));
    await initRepo(workspaceRoot);

    const store = new TaskStore();
    const task = store.createTask({
      title: "isolated cancel",
      prompt: "cancel",
      model: "auto",
      executionIsolation: "required",
      reviewRequired: true,
    }) as Task;

    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => {};
      },
      async invokeAgent() {
        throw createAbortError();
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot,
      autoModelOverride: "mock",
    });

    await assert.rejects(() => executor.execute(task, {}), /AbortError/);

    const latestRun = store.getLatestTaskRun(task.id);
    assert.equal(latestRun?.status, "cancelled");
    assert.equal(latestRun?.captureStatus, "skipped");
    assert.equal(latestRun?.applyStatus, "skipped");
  });

  it("fails the run when required-isolation worktree setup fails", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(tmpDir, "not-a-repo-"));
    const store = new TaskStore();
    const task = store.createTask({
      title: "isolated setup fail",
      prompt: "setup",
      model: "auto",
      executionIsolation: "required",
      reviewRequired: true,
    }) as Task;

    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => {};
      },
      async invokeAgent() {
        return { response: "unreachable" };
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot,
      autoModelOverride: "mock",
    });

    await assert.rejects(() => executor.execute(task, {}), /git/i);

    const latestRun = store.getLatestTaskRun(task.id);
    assert.equal(latestRun?.status, "failed");
    assert.equal(latestRun?.captureStatus, "failed");
    assert.equal(latestRun?.applyStatus, "failed");
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { TaskStore } from "../../server/tasks/store.js";
import type { Task } from "../../server/tasks/types.js";
import { OrchestratorTaskExecutor, persistTaskWorktreeReference } from "../../server/tasks/executor.js";

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
});

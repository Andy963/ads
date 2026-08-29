import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDatabaseForTests } from "../../server/storage/database.js";
import { createAbortError } from "../../server/utils/abort.js";
import { OrchestratorTaskExecutor } from "../../server/tasks/executor.js";
import { TaskStore } from "../../server/tasks/store.js";
import type { Task } from "../../server/tasks/types.js";
import type { AgentEvent } from "../../server/codex/events.js";

describe("tasks/executor step traces", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-exec-traces-"));
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

  it("emits live step traces for whitelist phases with source step and correct formatting", async () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;

    let eventHandler: ((ev: AgentEvent) => void) | null = null;
    let unsubscribed = false;

    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent(handler: (ev: AgentEvent) => void) {
        eventHandler = handler;
        return () => {
          unsubscribed = true;
          eventHandler = null;
        };
      },
      async invokeAgent() {
        assert.ok(eventHandler);

        // 1. boot phase
        eventHandler!({
          phase: "boot",
          title: "Initializing thread",
          detail: "thread#123",
          timestamp: Date.now(),
          raw: { type: "thread.started", thread_id: "123" } as any,
        });

        // 2. analysis phase (detail should be ignored)
        eventHandler!({
          phase: "analysis",
          title: "Analyzing problem",
          detail: "this detail should be omitted",
          timestamp: Date.now(),
          raw: { type: "turn.started" } as any,
        });

        // 3. context phase
        eventHandler!({
          phase: "context",
          title: "Loading context",
          detail: "3 files",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "context" } } as any,
        });

        // 4. editing phase
        eventHandler!({
          phase: "editing",
          title: "Applying changes",
          detail: "edit:src/index.ts",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "file_change", changes: [] } } as any,
        });

        // 5. tool phase
        eventHandler!({
          phase: "tool",
          title: "Executing tool",
          detail: "bash.exec",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "tool_call", tool: "exec" } } as any,
        });

        // 6. connection phase
        eventHandler!({
          phase: "connection",
          title: "Reconnecting",
          detail: "1/3",
          timestamp: Date.now(),
          raw: { type: "error", message: "reconnecting... 1/3" } as any,
        });

        // 7. responding phase (source chat)
        eventHandler!({
          phase: "responding",
          title: "Generating response",
          delta: "Hello ",
          timestamp: Date.now(),
          raw: { type: "item.updated", item: { type: "agent_message", text: "Hello " } } as any,
        });
        eventHandler!({
          phase: "responding",
          title: "Generating response",
          delta: "Hello world",
          timestamp: Date.now(),
          raw: { type: "item.updated", item: { type: "agent_message", text: "Hello world" } } as any,
        });

        // 8. command phase (should trigger onCommand, not onMessageDelta)
        eventHandler!({
          phase: "command",
          title: "执行命令",
          detail: "npm test | exit code 0",
          timestamp: Date.now(),
          raw: { type: "item.started", item: { type: "command_execution", command: "npm test" } } as any,
        });

        // 9. ignored phases (completed, error, unknown, empty title)
        eventHandler!({
          phase: "completed",
          title: "Completed",
          timestamp: Date.now(),
          raw: { type: "turn.completed" } as any,
        });
        eventHandler!({
          phase: "error",
          title: "Error",
          detail: "failed",
          timestamp: Date.now(),
          raw: { type: "turn.failed", error: { message: "failed" } } as any,
        });
        eventHandler!({
          phase: "unknown" as any,
          title: "Unknown",
          timestamp: Date.now(),
          raw: {} as any,
        });
        eventHandler!({
          phase: "tool",
          title: "",
          detail: "empty title",
          timestamp: Date.now(),
          raw: {} as any,
        });

        return { response: "Hello world" };
      },
    };

    const deltas: Array<{ role: string; delta: string; source?: "step" | "chat" }> = [];
    const commands: string[] = [];

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await executor.execute(task, {
      hooks: {
        onMessageDelta(message) {
          deltas.push({ role: message.role, delta: message.delta, source: message.source });
        },
        onCommand(payload) {
          commands.push(payload.command);
        },
      },
    });

    assert.equal(unsubscribed, true);
    assert.deepEqual(commands, ["npm test"]);

    // Check emitted deltas
    assert.deepEqual(deltas, [
      { role: "assistant", delta: "[boot] Initializing thread: thread#123\n", source: "step" },
      { role: "assistant", delta: "[analysis] Analyzing problem\n", source: "step" },
      { role: "assistant", delta: "[context] Loading context: 3 files\n", source: "step" },
      { role: "assistant", delta: "[editing] Applying changes: edit:src/index.ts\n", source: "step" },
      { role: "assistant", delta: "[tool] Executing tool: bash.exec\n", source: "step" },
      { role: "assistant", delta: "[connection] Reconnecting: 1/3\n", source: "step" },
      { role: "assistant", delta: "Hello ", source: "chat" },
      { role: "assistant", delta: "world", source: "chat" },
    ]);

    // Check that step deltas are NOT written to stored assistant messages
    const messages = store.getMessages(task.id);
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0]?.content, "Hello world");
  });

  it("unsubscribes on task failure", async () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;

    let unsubscribed = false;
    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => {
          unsubscribed = true;
        };
      },
      async invokeAgent() {
        throw new Error("execution failure");
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await assert.rejects(
      async () => {
        await executor.execute(task, {});
      },
      { message: "execution failure" },
    );

    assert.equal(unsubscribed, true);
  });

  it("unsubscribes on task cancellation", async () => {
    const store = new TaskStore();
    const task = store.createTask({ title: "T", prompt: "P", model: "auto" }) as Task;

    let unsubscribed = false;
    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() {
        return () => {
          unsubscribed = true;
        };
      },
      async invokeAgent() {
        throw createAbortError("cancelled");
      },
    };

    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as any,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await assert.rejects(
      async () => {
        await executor.execute(task, {});
      },
      { name: "AbortError" },
    );

    assert.equal(unsubscribed, true);
  });
});

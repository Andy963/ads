import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OrchestratorTaskExecutor } from "../../server/tasks/executor.js";
import { TaskStore } from "../../server/tasks/store.js";
import type { Task } from "../../server/tasks/types.js";
import { resetDatabaseForTests } from "../../server/storage/database.js";
import {
  setConversationMessageRecorder,
  type ConversationMessage,
} from "../../server/utils/conversationMessageRecorder.js";

describe("task executor conversation recorder", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-recorder-"));
    process.env.ADS_DATABASE_PATH = path.join(tmpDir, "tasks.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    setConversationMessageRecorder(null);
    resetDatabaseForTests();
    delete process.env.ADS_DATABASE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("publishes the persisted user and final assistant messages", async () => {
    const recorded: ConversationMessage[] = [];
    setConversationMessageRecorder({ record: (message) => recorded.push(message) });
    const store = new TaskStore();
    const task = store.createTask({ title: "Fix bug", prompt: "Apply the fix", model: "auto" }) as Task;
    const orchestrator = {
      setModel() {},
      setWorkingDirectory() {},
      onEvent() { return () => undefined; },
      async invokeAgent() { return { response: "Done" }; },
    };
    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: () => orchestrator as never,
      store,
      workspaceRoot: tmpDir,
      autoModelOverride: "mock",
    });

    await executor.execute(task);

    assert.deepEqual(recorded.map(({ source, role, text, workspaceRoot }) => ({ source, role, text, workspaceRoot })), [
      { source: "task", role: "user", text: "任务标题: Fix bug\n任务描述: Apply the fix", workspaceRoot: tmpDir },
      { source: "task", role: "assistant", text: "Done", workspaceRoot: tmpDir },
    ]);
  });
});

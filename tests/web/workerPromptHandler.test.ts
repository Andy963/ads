import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachWorkerPromptHandler } from "../../server/web/server/ws/workerPromptHandler.js";

function createHarness() {
  const sent: unknown[] = [];
  const history: Array<{ role: string; text: string; kind?: string }> = [];
  let eventHandler: ((event: any) => void) | null = null;

  attachWorkerPromptHandler({
    orchestrator: {
      onEvent: (handler) => {
        eventHandler = handler;
        return () => {
          eventHandler = null;
        };
      },
    },
    turnCwd: "/tmp/project",
    historyKey: "history-1",
    historyStore: {
      add: (_key, entry) => {
        history.push({ role: entry.role, text: entry.text, kind: entry.kind });
        return true;
      },
    },
    sendToChat: (payload) => sent.push(payload),
    logger: { info: () => {}, debug: () => {} },
    sessionLogger: null,
  });

  assert.ok(eventHandler);
  return { emit: eventHandler, sent, history };
}

function commandEvent(args: {
  type: "item.started" | "item.updated" | "item.completed";
  id: string;
  command: string;
  status: string;
  aggregatedOutput?: string;
  exitCode?: number;
}) {
  return {
    phase: "command",
    title: "command",
    timestamp: Date.now(),
    raw: {
      type: args.type,
      item: {
        type: "command_execution",
        id: args.id,
        command: args.command,
        status: args.status,
        aggregated_output: args.aggregatedOutput,
        exit_code: args.exitCode,
      },
    },
  };
}

describe("web/server/ws/workerPromptHandler", () => {
  it("persists terminal agent command output as replayable execute history", () => {
    const { emit, history } = createHarness();

    emit(commandEvent({ type: "item.started", id: "cmd-1", command: "npm test", status: "inProgress" }));
    emit(
      commandEvent({
        type: "item.updated",
        id: "cmd-1",
        command: "npm test",
        status: "inProgress",
        aggregatedOutput: "line 1\n",
      }),
    );
    emit(
      commandEvent({
        type: "item.completed",
        id: "cmd-1",
        command: "npm test",
        status: "completed",
        aggregatedOutput: "line 1\nline 2\n",
        exitCode: 0,
      }),
    );

    assert.deepEqual(history, [
      { role: "status", text: "$ npm test", kind: "command" },
      { role: "status", text: "$ npm test\nline 1\nline 2", kind: "execute" },
    ]);
  });

  it("keeps non-zero exit codes in replayable execute history", () => {
    const { emit, history } = createHarness();

    emit(
      commandEvent({
        type: "item.completed",
        id: "cmd-1",
        command: "npm test",
        status: "failed",
        aggregatedOutput: "test failed\n",
        exitCode: 1,
      }),
    );

    assert.deepEqual(history, [
      { role: "status", text: "$ npm test", kind: "command" },
      { role: "status", text: "$ npm test\ntest failed\n[exit code 1]", kind: "execute" },
    ]);
  });

  it("persists a terminal command even when the completion has no new output delta", () => {
    const { emit, history, sent } = createHarness();

    emit(
      commandEvent({
        type: "item.started",
        id: "cmd-1",
        command: "git status --short",
        status: "inProgress",
      }),
    );
    emit(
      commandEvent({
        type: "item.updated",
        id: "cmd-1",
        command: "git status --short",
        status: "inProgress",
        aggregatedOutput: "M file.ts\n",
      }),
    );
    emit(
      commandEvent({
        type: "item.completed",
        id: "cmd-1",
        command: "git status --short",
        status: "completed",
        aggregatedOutput: "M file.ts\n",
      }),
    );

    assert.deepEqual(history, [
      { role: "status", text: "$ git status --short", kind: "command" },
      { role: "status", text: "$ git status --short\nM file.ts", kind: "execute" },
    ]);
    assert.equal(sent.filter((payload) => (payload as { type?: unknown }).type === "command").length, 3);
  });
});

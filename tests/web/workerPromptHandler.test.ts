import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachWorkerPromptHandler } from "../../server/web/server/ws/workerPromptHandler.js";

function createHarness() {
  const sent: unknown[] = [];
  const history: Array<{ role: string; text: string; kind?: string }> = [];
  const upserts: Array<{ role: string; text: string; kind?: string }> = [];
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
      upsertEntryByKind: (_key, entry) => {
        upserts.push({ role: entry.role, text: entry.text, kind: entry.kind });
        return "inserted";
      },
    },
    sendToChat: (payload) => sent.push(payload),
    logger: { info: () => {}, debug: () => {} },
    sessionLogger: null,
  });

  assert.ok(eventHandler);
  return { emit: eventHandler, sent, history, upserts };
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
  it("forwards live agent command output without persisting replayable history", () => {
    const { emit, history, sent } = createHarness();

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

    assert.deepEqual(history, []);
    assert.equal(sent.filter((payload) => (payload as { type?: unknown }).type === "command").length, 3);
  });

  it("forwards failed agent command completion without persisting replayable history", () => {
    const { emit, history, sent } = createHarness();

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

    assert.deepEqual(history, []);
    const commandMessages = sent.filter((payload) => (payload as { type?: unknown }).type === "command") as Array<{
      command?: { status?: string; exit_code?: number };
    }>;
    assert.equal(commandMessages.length, 1);
    assert.equal(commandMessages[0]?.command?.status, "failed");
    assert.equal(commandMessages[0]?.command?.exit_code, 1);
  });

  it("forwards terminal command even when the completion has no new output delta", () => {
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

    assert.deepEqual(history, []);
    assert.equal(sent.filter((payload) => (payload as { type?: unknown }).type === "command").length, 3);
  });

  it("forwards todo_list events as plan messages and persists snapshots by kind", () => {
    const { emit, sent, upserts } = createHarness();

    const baseEvent = (eventType: "item.started" | "item.updated" | "item.completed", items: Array<{ text: string; status: string }>) => ({
      phase: "analysis",
      title: "todo",
      timestamp: Date.now(),
      raw: {
        type: eventType,
        item: {
          type: "todo_list",
          id: "plan-1",
          status: eventType === "item.completed" ? "completed" : "in_progress",
          items: items.map((entry) => ({ text: entry.text, status: entry.status })),
        },
      },
    });

    emit(
      baseEvent("item.started", [
        { text: "Step A", status: "pending" },
        { text: "Step B", status: "pending" },
      ]),
    );
    emit(
      baseEvent("item.updated", [
        { text: "Step A", status: "in_progress" },
        { text: "Step B", status: "pending" },
      ]),
    );
    emit(
      baseEvent("item.completed", [
        { text: "Step A", status: "completed" },
        { text: "Step B", status: "completed" },
      ]),
    );

    const planMessages = sent.filter((payload) => (payload as { type?: unknown }).type === "plan") as Array<{
      planId: string;
      status: string;
      items: Array<{ text: string; status: string }>;
    }>;
    assert.equal(planMessages.length, 3);
    assert.equal(planMessages[0]?.status, "in_progress");
    assert.equal(planMessages[2]?.status, "completed");
    assert.equal(planMessages[2]?.items[0]?.status, "completed");

    // All three updates share the same plan kind so they upsert in place.
    assert.equal(upserts.length, 3);
    for (const entry of upserts) {
      assert.equal(entry.kind, "plan:plan-1");
      assert.equal(entry.role, "status");
    }
    // Final upsert must include the completed items.
    const finalPersisted = upserts[upserts.length - 1]?.text ?? "";
    const parsed = JSON.parse(finalPersisted) as { items: Array<{ status: string }>; status: string };
    assert.equal(parsed.status, "completed");
    assert.deepEqual(parsed.items.map((entry) => entry.status), ["completed", "completed"]);
  });
});

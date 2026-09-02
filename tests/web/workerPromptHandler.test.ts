import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachWorkerPromptHandler } from "../../server/web/server/ws/workerPromptHandler.js";

function createHarness() {
  const sent: unknown[] = [];
  const history: Array<{ role: string; text: string; kind?: string }> = [];
  const upserts: Array<{ role: string; text: string; kind?: string }> = [];
  let eventHandler: ((event: any) => void) | null = null;

  const handler = attachWorkerPromptHandler({
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
  return { emit: eventHandler, sent, history, upserts, handler };
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

function respondingEvent(itemId: string, text: string) {
  return {
    phase: "responding",
    title: "生成回复",
    timestamp: Date.now(),
    delta: text,
    raw: {
      type: "item.updated",
      item: { type: "agent_message", id: itemId, text },
    },
  };
}

function reasoningEvent(text: string) {
  return {
    phase: "analysis",
    title: "Reasoning",
    timestamp: Date.now(),
    delta: text,
    raw: {
      type: "item.updated",
      item: { type: "reasoning", id: "reasoning-1", text },
    },
  };
}

describe("web/server/ws/workerPromptHandler", () => {
  it("slices cumulative responding text independently for each agent message item", () => {
    const { emit, sent } = createHarness();

    emit(respondingEvent("message-a", "First response"));
    emit(respondingEvent("message-b", "Second response"));
    emit(respondingEvent("message-a", "First response continued"));
    emit(respondingEvent("message-b", "Second response continued"));
    emit(respondingEvent("message-a", "First"));

    const deltas = sent
      .filter((payload) => (payload as { type?: unknown }).type === "delta")
      .map((payload) => (payload as { delta?: unknown }).delta);
    assert.deepEqual(deltas, ["First response", "Second response", " continued", " continued"]);
  });

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

  it("keeps only the latest substantive step snapshot without mixing it into command history", () => {
    const { emit, handler, history, sent } = createHarness();

    emit({
      phase: "tool",
      title: "Inspecting workspace",
      detail: "bash",
      timestamp: 1,
      raw: { type: "item.started", item: { type: "tool_call" } },
    });
    emit(commandEvent({ type: "item.started", id: "cmd-1", command: "npm test", status: "inProgress" }));
    emit({
      phase: "editing",
      title: "Updating file",
      detail: "src/index.ts",
      timestamp: 2,
      raw: { type: "item.started", item: { type: "file_change" } },
    });

    assert.equal(handler.getStepTraceText(), "[editing] Updating file: src/index.ts\n");
    const stepDeltas = sent
      .filter((payload) => {
        const item = payload as { type?: unknown; source?: unknown };
        return item.type === "delta" && item.source === "step";
      })
      .map((payload) => (payload as { delta?: unknown }).delta);
    assert.deepEqual(stepDeltas, [
      "[tool] Inspecting workspace: bash\n",
      "[editing] Updating file: src/index.ts\n",
    ]);
    assert.equal(sent.filter((payload) => (payload as { type?: unknown }).type === "command").length, 1);
    assert.deepEqual(history, []);
  });

  it("keeps incremental reasoning classified as noise and preserves the completion snapshot", () => {
    const { emit, handler, sent } = createHarness();

    emit({
      phase: "tool",
      title: "Inspecting workspace",
      detail: "bash",
      timestamp: 1,
      raw: { type: "item.started", item: { type: "tool_call" } },
    });
    emit(reasoningEvent("first reasoning"));
    emit(reasoningEvent("first reasoning plus follow-up"));

    const stepDeltas = sent
      .filter((payload) => {
        const item = payload as { type?: unknown; source?: unknown };
        return item.type === "delta" && item.source === "step";
      })
      .map((payload) => (payload as { delta?: unknown }).delta);
    assert.deepEqual(stepDeltas, [
      "[tool] Inspecting workspace: bash\n",
      "[analysis] first reasoning",
      "[analysis]  plus follow-up",
    ]);
    assert.equal(handler.getStepTraceText(), "[tool] Inspecting workspace: bash\n");
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

  it("suppresses retryable upstream turn failures until the outer retry decision", () => {
    const { emit, sent } = createHarness();

    emit({
      phase: "error",
      title: "执行失败",
      detail: "We're currently experiencing high demand, which may cause temporary errors.",
      timestamp: Date.now(),
      raw: {
        type: "turn.failed",
        error: { message: "We're currently experiencing high demand, which may cause temporary errors." },
      },
    });

    assert.deepEqual(sent, []);
  });

  it("suppresses retryable upstream error events until the outer retry decision", () => {
    const { emit, sent } = createHarness();

    emit({
      phase: "error",
      title: "请求失败",
      detail: "upstream request failed with status 429",
      timestamp: Date.now(),
      raw: {
        type: "error",
        message: "upstream request failed with status 429",
      },
    });

    assert.deepEqual(sent, []);
  });

  it("forwards explicit external retry decisions with the runner count", () => {
    const { emit, sent } = createHarness();

    emit({
      phase: "connection",
      title: "模型请求重试",
      detail: "upstream request failed with status 429",
      timestamp: Date.now(),
      raw: {
        type: "error",
        message: "upstream request failed with status 429",
      },
      retry: {
        source: "external",
        retryCount: 3,
        nextAttempt: 4,
        maxAttempts: 101,
        delayMs: 800,
      },
    });

    assert.deepEqual(sent.at(-1), {
      type: "error",
      message: "upstream request failed with status 429",
      transient: true,
      retryable: true,
      retryCount: 3,
      nextAttempt: 4,
      maxAttempts: 101,
    });
  });

  it("keeps non-retryable turn failures as terminal chat errors", () => {
    const { emit, sent } = createHarness();

    emit({
      phase: "error",
      title: "执行失败",
      detail: "fatal model error",
      timestamp: Date.now(),
      raw: {
        type: "turn.failed",
        error: { message: "fatal model error" },
      },
    });

    assert.deepEqual(sent.at(-1), {
      type: "error",
      message: "fatal model error",
    });
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

  it("keeps one logical plan when provider item IDs change within a turn", () => {
    const { emit, sent, upserts } = createHarness();

    emit({
      phase: "analysis",
      title: "plan",
      timestamp: 1,
      raw: {
        type: "item.updated",
        item: { type: "todo_list", id: "tool-call-1", items: [{ text: "Step A", status: "in_progress" }] },
      },
    });
    emit({
      phase: "analysis",
      title: "plan",
      timestamp: 2,
      raw: {
        type: "item.updated",
        item: { type: "todo_list", id: "tool-call-2", items: [{ text: "Step A", status: "completed" }] },
      },
    });

    const planMessages = sent.filter((payload) => (payload as { type?: unknown }).type === "plan") as Array<{ planId: string }>;
    assert.deepEqual(planMessages.map((message) => message.planId), ["tool-call-1", "tool-call-1"]);
    assert.deepEqual(upserts.map((entry) => entry.kind), ["plan:tool-call-1", "plan:tool-call-1"]);
  });

  it("publishes an authoritative completed snapshot when the turn succeeds", () => {
    const { emit, sent, upserts } = createHarness();

    emit({
      phase: "analysis",
      title: "plan",
      timestamp: 1,
      raw: {
        type: "item.updated",
        item: {
          type: "todo_list",
          id: "plan-final",
          items: [
            { text: "Step A", status: "completed" },
            { text: "Step B", status: "in_progress" },
          ],
        },
      },
    });
    emit({ phase: "done", title: "done", timestamp: 2, raw: { type: "turn.completed" } });

    const finalMessage = sent.at(-1) as { type: string; status: string; items: Array<{ status: string }> };
    assert.equal(finalMessage.type, "plan");
    assert.equal(finalMessage.status, "completed");
    assert.deepEqual(finalMessage.items.map((item) => item.status), ["completed", "completed"]);
    const persisted = JSON.parse(upserts.at(-1)?.text ?? "{}") as { status?: string };
    assert.equal(persisted.status, "completed");
  });

  it("creates a new card for a distinct plan after the prior plan completes", () => {
    const { emit, sent } = createHarness();
    emit({
      phase: "analysis", title: "plan", timestamp: 1,
      raw: { type: "item.completed", item: { type: "todo_list", id: "plan-a", items: [{ text: "Step A", status: "completed" }] } },
    });
    emit({
      phase: "analysis", title: "plan", timestamp: 2,
      raw: { type: "item.started", item: { type: "todo_list", id: "plan-b", items: [{ text: "Step B", status: "pending" }] } },
    });

    const plans = sent.filter((payload) => (payload as { type?: unknown }).type === "plan") as Array<{ planId: string }>;
    assert.deepEqual(plans.map((plan) => plan.planId), ["plan-a", "plan-b"]);
  });
});

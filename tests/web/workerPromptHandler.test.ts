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

    const thoughtDeltas = sent
      .filter((payload) => {
        const item = payload as { type?: unknown; source?: unknown };
        return item.type === "delta" && item.source === "thought";
      })
      .map((payload) => (payload as { delta?: unknown }).delta);
    assert.deepEqual(thoughtDeltas, [
      "first reasoning",
      " plus follow-up",
    ]);
    assert.equal(handler.getThoughtText(), "first reasoning plus follow-up");

    const stepDeltas = sent
      .filter((payload) => {
        const item = payload as { type?: unknown; source?: unknown };
        return item.type === "delta" && item.source === "step";
      })
      .map((payload) => (payload as { delta?: unknown }).delta);
    assert.deepEqual(stepDeltas, [
      "[tool] Inspecting workspace: bash\n",
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

  it("decommissions todo_list plan events and does not emit synthetic plan messages (ADR 0002)", () => {
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

    // ADR 0002: todo_list events are decommissioned from emitting plan messages or persisting plan:* snapshots
    const planMessages = sent.filter((payload) => (payload as { type?: unknown }).type === "plan");
    assert.equal(planMessages.length, 0);
    const planUpserts = upserts.filter((entry) => entry.kind.startsWith("plan:"));
    assert.equal(planUpserts.length, 0);
  });
  it("handles out-of-order old completion and new delta without double phase_complete", () => {
    const { emit, sent } = createHarness();

    // 1. First message streams
    emit(respondingEvent("msg-1", "Hello from msg 1"));
    // 2. New delta for msg-2 arrives BEFORE msg-1 completion event
    emit(respondingEvent("msg-2", "Hello from msg 2"));

    // Should have emitted exactly one phase_complete when transitioning msg-1 -> msg-2
    let phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 1);

    // 3. Late arrival of msg-1 completed event
    emit({
      phase: "responding",
      title: "done 1",
      timestamp: Date.now(),
      raw: {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-1" },
      },
    });

    // Must NOT emit a second phase_complete that would prematurely seal msg-2
    phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 1);

    // 4. Now msg-2 legitimately completes
    emit({
      phase: "responding",
      title: "done 2",
      timestamp: Date.now(),
      raw: {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-2" },
      },
    });

    phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 2);
  });
  it("ignores id-less old completion after a new identified delta begins (Finding A)", () => {
    const { emit, sent } = createHarness();

    // 1. Identified message streams
    emit(respondingEvent("msg-identified-1", "Identified text"));

    // 2. An anonymous / id-less old completion arrives out of order
    emit({
      phase: "responding",
      title: "done unknown",
      timestamp: Date.now(),
      raw: {
        type: "item.completed",
        item: { type: "agent_message" },
      },
    });

    // Must NOT emit phase_complete and must NOT seal msg-identified-1
    const phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 0);
  });
  it("does not double-seal active identified phase when stale anonymous completion arrives after transition", () => {
    const { emit, sent } = createHarness();

    // 1. Anonymous delta arrives (no item ID)
    emit({
      phase: "responding",
      title: "streaming anon",
      delta: "Anonymous delta text",
      timestamp: 1000,
      raw: { type: "item.started", item: { type: "agent_message" } },
    });

    // 2. Identified message begins streaming -> seals anonymous phase
    emit(respondingEvent("msg-identified-2", "Identified text"));
    let phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 1);

    // 3. Stale anonymous completion arrives out of order
    emit({
      phase: "responding",
      title: "done anon",
      timestamp: 2000,
      raw: {
        type: "item.completed",
        item: { type: "agent_message" },
      },
    });

    // Must NOT emit a second phase_complete that would seal msg-identified-2
    phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 1);

    // 4. Identified message finishes
    emit({
      phase: "responding",
      title: "done 2",
      timestamp: 3000,
      raw: {
        type: "item.completed",
        item: { type: "agent_message", id: "msg-identified-2" },
      },
    });
    phaseEvents = sent.filter((p: any) => p.type === "phase_complete");
    assert.equal(phaseEvents.length, 2);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachWorkerPromptHandler } from "../../server/web/server/ws/workerPromptHandler.js";

describe("Issue #129: Backend visible execution contract", () => {
  it("drops hidden reasoning but forwards provider summary text as live-step", () => {
    const sent: unknown[] = [];
    let eventHandler: ((event: any) => void) | null = null;

    const handler = attachWorkerPromptHandler({
      orchestrator: {
        onEvent: (h) => {
          eventHandler = h;
          return () => {
            eventHandler = null;
          };
        },
      },
      turnCwd: "/tmp/project",
      historyKey: "history-1",
      historyStore: {
        add: () => true,
        upsertEntryByKind: () => "inserted",
      },
      sendToChat: (payload) => sent.push(payload),
      logger: { info: () => {}, debug: () => {} },
      sessionLogger: null,
    });

    assert.ok(eventHandler);

    // Turn starts
    eventHandler!({
      phase: "analysis",
      title: "turn",
      timestamp: Date.now(),
      raw: { type: "turn.started" },
    });

    // Reasoning arrives
    eventHandler!({
      phase: "analysis",
      title: "Reasoning",
      timestamp: Date.now(),
      delta: "Thinking through the solution...",
      raw: {
        type: "item.updated",
        item: { type: "reasoning", id: "r-1", text: "Thinking through the solution..." },
      },
    });

    // Incremental reasoning arrives
    eventHandler!({
      phase: "analysis",
      title: "Reasoning",
      timestamp: Date.now(),
      delta: "Thinking through the solution... Found the issue.",
      raw: {
        type: "item.updated",
        item: { type: "reasoning", id: "r-1", text: "Thinking through the solution... Found the issue." },
      },
    });

    eventHandler!({
      phase: "analysis",
      title: "Provider live step",
      timestamp: Date.now(),
      delta: "I will inspect the relevant files before running a command.",
      liveStep: true,
      raw: {
        type: "item.updated",
        item: {
          type: "reasoning",
          id: "summary-1",
          text: "I will inspect the relevant files before running a command.",
          summary: true,
        },
      },
    });

    assert.equal(sent.length, 1);
    assert.equal((sent[0] as any).type, "delta");
    assert.equal((sent[0] as any).delta, "I will inspect the relevant files before running a command.");
    assert.equal((sent[0] as any).source, "step");
    assert.equal(typeof (sent[0] as any).ts, "number");
    assert.equal("getThoughtText" in handler, false);
  });

  it("does not turn tool executions into synthetic live-step text", () => {
    let eventHandler: ((event: any) => void) | null = null;

    const sent: unknown[] = [];
    const handler = attachWorkerPromptHandler({
      orchestrator: {
        onEvent: (h) => {
          eventHandler = h;
          return () => {
            eventHandler = null;
          };
        },
      },
      turnCwd: "/tmp/project",
      historyKey: "history-1",
      historyStore: {
        add: () => true,
        upsertEntryByKind: () => "inserted",
      },
      sendToChat: (payload) => sent.push(payload),
      logger: { info: () => {}, debug: () => {} },
      sessionLogger: null,
    });

    eventHandler!({
      phase: "analysis",
      title: "turn",
      timestamp: Date.now(),
      raw: { type: "turn.started" },
    });

    eventHandler!({
      phase: "tool",
      title: "Calling tool",
      detail: "bash",
      timestamp: Date.now(),
      raw: { type: "item.started", item: { type: "tool_call" } },
    });

    eventHandler!({
      phase: "editing",
      title: "Editing file",
      detail: "file.ts",
      timestamp: Date.now(),
      raw: { type: "item.started", item: { type: "file_change" } },
    });

    const stepDeltas = sent.filter(
      (m: any) => m.type === "delta" && m.source === "step",
    );
    assert.deepEqual(stepDeltas.map((item: any) => item.delta), []);
    assert.equal("getThoughtText" in handler, false);
  });
});

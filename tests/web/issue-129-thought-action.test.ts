import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachWorkerPromptHandler } from "../../server/web/server/ws/workerPromptHandler.js";

describe("Issue #129: Backend Thought and Action Decoupling", () => {
  it("emits cognitive reasoning as dedicated source: thought delta", () => {
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

    const thoughtDeltas = sent.filter(
      (m: any) => m.type === "delta" && m.source === "thought",
    );
    assert.equal(thoughtDeltas.length, 2);
    assert.equal((thoughtDeltas[0] as any).delta, "Thinking through the solution...");
    assert.equal((thoughtDeltas[1] as any).delta, " Found the issue.");

    // Action step traces are separate from thought
    assert.equal(handler.getThoughtText(), "Thinking through the solution... Found the issue.");
  });

  it("does not mix tool executions into thought text", () => {
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
      sendToChat: () => {},
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

    // Tool and editing traces are NOT in thought text
    assert.equal(handler.getThoughtText(), "");
  });
});


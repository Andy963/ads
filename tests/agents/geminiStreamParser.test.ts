import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GeminiStreamParser } from "../../src/agents/cli/geminiStreamParser.js";

describe("GeminiStreamParser", () => {
  it("maps init to boot + analysis and captures session id", () => {
    const parser = new GeminiStreamParser();
    const events = parser.parseLine({
      type: "init",
      session_id: "dc3ec485-5c05-460c-8de2-5d7af0ee5d30",
      model: "auto-gemini-2.5",
    });
    assert.equal(parser.getSessionId(), "dc3ec485-5c05-460c-8de2-5d7af0ee5d30");
    assert.equal(events.some((e) => e.phase === "boot"), true);
    assert.equal(events.some((e) => e.phase === "analysis"), true);
  });

  it("accumulates assistant delta messages into responding events", () => {
    const parser = new GeminiStreamParser();
    parser.parseLine({ type: "init", session_id: "sid" });

    const first = parser.parseLine({ type: "message", role: "assistant", content: "Hello", delta: true });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.phase, "responding");
    assert.equal(first[0]?.delta, "Hello");

    const second = parser.parseLine({ type: "message", role: "assistant", content: " world", delta: true });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.delta, "Hello world");
    assert.equal(parser.getFinalMessage(), "Hello world");
  });

  it("maps tool_use + tool_result into MCP tool call events", () => {
    const parser = new GeminiStreamParser();
    parser.parseLine({ type: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "tool_use",
      tool_name: "list_directory",
      tool_id: "t1",
      parameters: { dir_path: "." },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "tool");

    const completed = parser.parseLine({ type: "tool_result", tool_id: "t1", status: "success", output: "ok" });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "tool");
  });

  it("maps result success into completed event", () => {
    const parser = new GeminiStreamParser();
    parser.parseLine({ type: "init", session_id: "sid" });
    const events = parser.parseLine({ type: "result", status: "success" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.phase, "completed");
  });
});


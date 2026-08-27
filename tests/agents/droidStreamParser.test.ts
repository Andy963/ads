import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DroidStreamParser } from "../../server/agents/cli/droidStreamParser.js";

describe("DroidStreamParser", () => {
  it("maps init, messages, and completion", () => {
    const parser = new DroidStreamParser();
    assert.equal(parser.parseLine({ type: "system", subtype: "init", session_id: "sid" }).some((event) => event.phase === "boot"), true);
    assert.equal(parser.parseLine({ type: "message", role: "assistant", content: "hello" }).at(-1)?.delta, "hello");
    const completed = parser.parseLine({ type: "completion", session_id: "sid", usage: { input_tokens: 2, output_tokens: 3 } });
    assert.equal(completed[0]?.phase, "completed");
    assert.deepEqual(parser.getUsage(), { input_tokens: 2, output_tokens: 3 });
    assert.equal(parser.getFinalMessage(), "hello");
  });

  it("preserves and maps command-like tool payloads", () => {
    const parser = new DroidStreamParser();
    const events = parser.parseLine({ type: "tool_call", id: "t1", toolName: "Execute", parameters: { command: "echo hi" } });
    assert.equal(events[0]?.phase, "command");
    assert.equal((events[0]?.raw as { __cli?: unknown }).__cli !== undefined, true);

    const completed = parser.parseLine({ type: "tool_result", id: "t1", isError: false, value: "hi" });
    assert.equal(completed[0]?.phase, "command");
  });

  it("maps Droid web search, task, and plan tools through ADS events", () => {
    const parser = new DroidStreamParser();

    const search = parser.parseLine({
      type: "tool_call",
      id: "search-1",
      toolName: "WebSearch",
      parameters: { query: "Factory Droid" },
    });
    assert.equal(search[0]?.phase, "tool");

    const task = parser.parseLine({
      type: "tool_call",
      id: "task-1",
      toolName: "Task",
      parameters: { description: "Inspect files", prompt: "Read the repository" },
    });
    assert.equal(task[0]?.phase, "tool");

    const plan = parser.parseLine({
      type: "tool_call",
      id: "plan-1",
      toolName: "TodoWrite",
      parameters: { todos: [{ content: "Implement adapter", status: "in_progress" }] },
    });
    assert.equal(plan[0]?.phase, "editing");
  });
});

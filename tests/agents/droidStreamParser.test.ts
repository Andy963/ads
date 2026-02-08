import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DroidStreamParser } from "../../src/agents/cli/droidStreamParser.js";

describe("DroidStreamParser", () => {
  it("maps system init to boot + analysis and captures session id", () => {
    const parser = new DroidStreamParser();
    const events = parser.parseLine({
      type: "system",
      subtype: "init",
      session_id: "sid-123",
      cwd: "/tmp",
    });
    assert.equal(parser.getSessionId(), "sid-123");
    assert.equal(events.some((e) => e.phase === "boot"), true);
    assert.equal(events.some((e) => e.phase === "analysis"), true);
  });

  it("accumulates assistant messages into responding events", () => {
    const parser = new DroidStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const first = parser.parseLine({
      type: "message",
      role: "assistant",
      id: "m1",
      text: "Hello",
    });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.phase, "responding");
    assert.equal(first[0]?.delta, "Hello");

    const second = parser.parseLine({
      type: "message",
      role: "assistant",
      id: "m1",
      text: "Hello world",
    });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.delta, "Hello world");
    assert.equal(parser.getFinalMessage(), "Hello world");
  });

  it("maps Execute tool_call + tool_result into command_execution events", () => {
    const parser = new DroidStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "tool_call",
      id: "c1",
      toolId: "Execute",
      toolName: "Execute",
      parameters: { command: "echo hi" },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "command");
    assert.equal((started[0]?.raw as { type?: string }).type, "item.started");

    const completed = parser.parseLine({
      type: "tool_result",
      id: "c1",
      toolId: "Execute",
      isError: false,
      value: "hi\n",
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "command");
    assert.equal(completed[0]?.title, "命令完成");
    const raw = completed[0]?.raw as { item?: { type?: string; aggregated_output?: string } };
    assert.equal(raw.item?.type, "command_execution");
    assert.equal(raw.item?.aggregated_output, "hi\n");
  });

  it("maps LS tool_call + tool_result into tool events", () => {
    const parser = new DroidStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "tool_call",
      id: "t1",
      toolId: "LS",
      toolName: "LS",
      parameters: { directory_path: "." },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "tool");

    const completed = parser.parseLine({
      type: "tool_result",
      id: "t1",
      toolId: "LS",
      isError: false,
      value: "ok",
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "tool");
    assert.equal(completed[0]?.title, "工具调用完成");
  });

  it("maps completion into completed event and finalizes agent message", () => {
    const parser = new DroidStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const events = parser.parseLine({
      type: "completion",
      finalText: "Done",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    assert.equal(events.some((e) => e.phase === "completed"), true);
    assert.equal(parser.getFinalMessage(), "Done");
  });
});


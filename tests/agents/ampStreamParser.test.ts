import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AmpStreamParser } from "../../src/agents/cli/ampStreamParser.js";

describe("AmpStreamParser", () => {
  it("maps system init to boot + analysis and captures session id", () => {
    const parser = new AmpStreamParser();
    const events = parser.parseLine({
      type: "system",
      subtype: "init",
      session_id: "T-abc123",
    });
    assert.equal(parser.getSessionId(), "T-abc123");
    assert.equal(events.some((e) => e.phase === "boot"), true);
    assert.equal(events.some((e) => e.phase === "analysis"), true);
  });

  it("streams assistant text as cumulative responding delta", () => {
    const parser = new AmpStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "T-abc123" });

    const first = parser.parseLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.phase, "responding");
    assert.equal(first[0]?.delta, "Hello");

    const second = parser.parseLine({
      type: "assistant",
      message: { content: [{ type: "text", text: " world" }] },
    });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.phase, "responding");
    assert.equal(second[0]?.delta, "Hello world");
    assert.equal(parser.getFinalMessage(), "Hello world");
  });

  it("streams reasoning as cumulative analysis delta", () => {
    const parser = new AmpStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "T-abc123" });

    const events = parser.parseLine({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "step1" }] },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.phase, "analysis");
    assert.equal(events[0]?.delta, "step1");
  });

  it("maps tool_use + tool_result for Bash into command_execution events", () => {
    const parser = new AmpStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "T-abc123" });

    const started = parser.parseLine({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }],
      },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "command");
    assert.equal((started[0]?.raw as { type?: string }).type, "item.started");

    const completed = parser.parseLine({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "hi\n", is_error: false }],
      },
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "command");
    assert.equal(completed[0]?.title, "命令完成");
    const raw = completed[0]?.raw as { item?: { type?: string; aggregated_output?: string } };
    assert.equal(raw.item?.type, "command_execution");
    assert.equal(raw.item?.aggregated_output, "hi\n");
  });

  it("maps edit_file tool_use into file_change events", () => {
    const parser = new AmpStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "T-abc123" });

    const started = parser.parseLine({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "f1", name: "edit_file", input: { path: "a.txt" } }],
      },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "editing");
    assert.equal(started[0]?.title, "准备文件修改");

    const completed = parser.parseLine({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "f1", content: "ok", is_error: false }],
      },
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "editing");
    assert.equal(completed[0]?.title, "应用文件修改");
    const raw = completed[0]?.raw as { type?: string; item?: { type?: string; changes?: unknown[] } };
    assert.equal(raw.type, "item.completed");
    assert.equal(raw.item?.type, "file_change");
    assert.equal(Array.isArray(raw.item?.changes), true);
  });

  it("maps result success into completed event", () => {
    const parser = new AmpStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "T-abc123" });
    parser.parseLine({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });

    const events = parser.parseLine({
      type: "result",
      subtype: "success",
      result: "Done",
    });
    assert.equal(events.some((e) => e.phase === "completed"), true);
    assert.equal(parser.getFinalMessage(), "Done");
  });

  it("maps result error into error event and exposes lastError", () => {
    const parser = new AmpStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "T-abc123" });

    const events = parser.parseLine({
      type: "result",
      subtype: "error_during_execution",
      error: "boom",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.phase, "error");
    assert.equal(parser.getLastError(), "boom");
  });
});


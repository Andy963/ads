import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeStreamParser } from "../../src/agents/cli/claudeStreamParser.js";

describe("ClaudeStreamParser", () => {
  it("maps system init to boot + analysis and captures session id", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parseLine({
      type: "system",
      subtype: "init",
      session_id: "117971d6-eaf5-43c3-8427-75adb2f49103",
    });
    assert.equal(parser.getSessionId(), "117971d6-eaf5-43c3-8427-75adb2f49103");
    assert.equal(events.some((e) => e.phase === "boot"), true);
    assert.equal(events.some((e) => e.phase === "analysis"), true);
  });

  it("streams assistant text as cumulative responding delta", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const first = parser.parseLine({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.phase, "responding");
    assert.equal(first[0]?.delta, "Hi");

    const second = parser.parseLine({ type: "assistant", message: { content: [{ type: "text", text: " there" }] } });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.delta, "Hi there");
  });

  it("maps Bash tool_use + tool_result into command_execution events", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "command");

    const completed = parser.parseLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi\n", is_error: false }] },
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "command");
    assert.equal(completed[0]?.title, "命令完成");
  });

  it("maps Edit tool_use into file_change events", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "f1", name: "Edit", input: { file_path: "a.txt" } }] },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "editing");
    assert.equal(started[0]?.title, "准备文件修改");

    const completed = parser.parseLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "f1", content: "ok", is_error: false }] },
    });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.phase, "editing");
    assert.equal(completed[0]?.title, "应用文件修改");
  });

  it("maps result error into error event and exposes lastError", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const events = parser.parseLine({ type: "result", subtype: "error_during_execution", error: "boom" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.phase, "error");
    assert.equal(parser.getLastError(), "boom");
  });
});


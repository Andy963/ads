import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeStreamParser } from "../../server/agents/cli/claudeStreamParser.js";

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

  it("treats success result with error payload as failure", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const events = parser.parseLine({
      type: "result",
      subtype: "success",
      error: { message: "x" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.phase, "error");
    assert.equal(events[0]?.detail, "x");
    assert.equal(parser.getLastError(), "x");
  });

  it("maps Task tool_use into subagent_dispatch (not generic tool_call)", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: {
              description: "Explore project layout",
              prompt: "Map the repo and report key dirs.",
              subagent_type: "general-purpose",
            },
          },
        ],
      },
    });
    assert.equal(started.length, 1);
    const startedEv = started[0]!;
    assert.equal(startedEv.phase, "subagent");
    assert.equal(startedEv.title, "调度子代理");

    const rawStarted = startedEv.raw as {
      type?: string;
      item?: { type?: string; subagent_type?: string; description?: string; prompt?: string; tool_use_id?: string; status?: string };
    };
    assert.equal(rawStarted.type, "item.started");
    assert.equal(rawStarted.item?.type, "subagent_dispatch");
    assert.notEqual(rawStarted.item?.type, "tool_call");
    assert.equal(rawStarted.item?.subagent_type, "general-purpose");
    assert.equal(rawStarted.item?.description, "Explore project layout");
    assert.equal(rawStarted.item?.prompt, "Map the repo and report key dirs.");
    assert.equal(rawStarted.item?.tool_use_id, "task-1");
    assert.equal(rawStarted.item?.status, "in_progress");

    const completed = parser.parseLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-1",
            content: "Found src/, tests/, docs/.",
            is_error: false,
          },
        ],
      },
    });
    assert.equal(completed.length, 1);
    const completedEv = completed[0]!;
    assert.equal(completedEv.phase, "subagent");
    assert.equal(completedEv.title, "子代理完成");
    const rawCompleted = completedEv.raw as {
      type?: string;
      item?: { type?: string; status?: string; result?: string; subagent_type?: string };
    };
    assert.equal(rawCompleted.type, "item.completed");
    assert.equal(rawCompleted.item?.type, "subagent_dispatch");
    assert.equal(rawCompleted.item?.status, "completed");
    assert.equal(rawCompleted.item?.result, "Found src/, tests/, docs/.");
    assert.equal(rawCompleted.item?.subagent_type, "general-purpose");
  });

  it("marks failed Task tool_result as subagent failure and emits error", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    parser.parseLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "task-err",
            name: "Task",
            input: { description: "Run thing", prompt: "do it", subagent_type: "Explore" },
          },
        ],
      },
    });
    const events = parser.parseLine({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "task-err", content: "boom", is_error: true },
        ],
      },
    });
    // Expect a completed subagent_dispatch event + an error event.
    assert.equal(events.length, 2);
    assert.equal(events[0]?.phase, "subagent");
    const rawCompleted = events[0]!.raw as { item?: { status?: string } };
    assert.equal(rawCompleted.item?.status, "failed");
    assert.equal(events[1]?.phase, "error");
    assert.ok(parser.getLastError()?.includes("boom"));
  });

  it("maps TodoWrite tool_use to a todo_list item with normalized statuses", () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine({ type: "system", subtype: "init", session_id: "sid" });

    const started = parser.parseLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "plan-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "First step", status: "completed" },
                { content: "Second step", status: "in_progress" },
                { content: "Third step", status: "pending" },
              ],
            },
          },
        ],
      },
    });
    assert.equal(started.length, 1);
    assert.equal(started[0]?.phase, "analysis");
    const rawStarted = started[0]!.raw as { type?: string; item?: { type?: string; items?: Array<{ text?: string; status?: string }> } };
    assert.equal(rawStarted.type, "item.started");
    assert.equal(rawStarted.item?.type, "todo_list");
    assert.deepEqual(
      rawStarted.item?.items?.map((entry) => ({ text: entry.text, status: entry.status })),
      [
        { text: "First step", status: "completed" },
        { text: "Second step", status: "in_progress" },
        { text: "Third step", status: "pending" },
      ],
    );

    const completed = parser.parseLine({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "plan-1", content: "Todos updated", is_error: false },
        ],
      },
    });
    assert.equal(completed.length, 1);
    const rawCompleted2 = completed[0]!.raw as { type?: string; item?: { type?: string; status?: string } };
    assert.equal(rawCompleted2.type, "item.completed");
    assert.equal(rawCompleted2.item?.type, "todo_list");
    assert.equal(rawCompleted2.item?.status, "completed");
  });
});

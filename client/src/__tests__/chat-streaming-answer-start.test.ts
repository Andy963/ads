import { describe, expect, it } from "vitest";

import { findStreamingAnswerId, hasExecutionBlockAfter } from "../app/chatStreaming";
import { isLiveMessageId } from "../app/chatLive";

type Item = { id: string; role: string; kind?: string; content?: string; streaming?: boolean };

function user(id: string): Item {
  return { id, role: "user", kind: "text", content: "prompt" };
}

function answer(id: string, content: string, streaming = true): Item {
  return { id, role: "assistant", kind: "text", content, streaming };
}

function execute(id: string, kind = "execute"): Item {
  return { id, role: "system", kind, content: "output", streaming: true };
}

describe("findStreamingAnswerId", () => {
  it("returns an empty string for an empty transcript", () => {
    expect(findStreamingAnswerId([], isLiveMessageId)).toBe("");
  });

  it("finds the streaming assistant text after the last user message", () => {
    const items = [user("u-1"), answer("a-1", "answer")];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("a-1");
  });

  it("prefers the streaming text after an execution block over earlier narration", () => {
    const items = [
      user("u-1"),
      answer("a-1", "intermediate narration"),
      execute("exec-1"),
      answer("a-2", "final answer"),
    ];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("a-2");
  });

  it("ignores the empty assistant placeholder pushed when the prompt is sent", () => {
    const items = [user("u-1"), answer("a-1", "")];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("");
  });

  it("ignores whitespace-only placeholder content", () => {
    const items = [user("u-1"), answer("a-1", "  \n  ")];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("");
  });

  it("ignores assistant text that is no longer streaming", () => {
    const items = [user("u-1"), answer("a-1", "finished answer", false)];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("");
  });

  it("ignores non-text assistant kinds such as thought blocks", () => {
    const items = [user("u-1"), { id: "t-1", role: "assistant", kind: "thought", content: "thinking", streaming: true }];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("");
  });

  it("ignores live cards even when they carry streaming text", () => {
    const items = [
      user("u-1"),
      { id: "live-step", role: "assistant", kind: "text", content: "running tests", streaming: true },
    ];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("");
  });

  it("ignores streaming answers from before the last user message", () => {
    const items = [answer("a-0", "previous turn"), user("u-1"), execute("exec-1")];
    expect(findStreamingAnswerId(items, isLiveMessageId)).toBe("");
  });
});

describe("hasExecutionBlockAfter", () => {
  it("returns false when nothing follows the message", () => {
    const items = [user("u-1"), answer("a-1", "answer")];
    expect(hasExecutionBlockAfter(items, "a-1")).toBe(false);
  });

  it.each(["execute", "command", "patch"])("detects a %s block below the message", (kind) => {
    const items = [user("u-1"), answer("a-1", "narration"), execute("exec-1", kind)];
    expect(hasExecutionBlockAfter(items, "a-1")).toBe(true);
  });

  it("ignores execution blocks above the message", () => {
    const items = [user("u-1"), execute("exec-1"), answer("a-1", "final answer")];
    expect(hasExecutionBlockAfter(items, "a-1")).toBe(false);
  });

  it("returns false for an unknown or empty message id", () => {
    const items = [user("u-1"), execute("exec-1")];
    expect(hasExecutionBlockAfter(items, "missing")).toBe(false);
    expect(hasExecutionBlockAfter(items, "")).toBe(false);
  });
});

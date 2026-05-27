import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryInjectionContext,
  prependContextToInput,
} from "../../server/web/server/ws/handlePrompt.js";

describe("context resume — history injection", () => {
  it("builds transcript from conversation and context-bearing status entries", () => {
    const entries = [
      { role: "user", text: "hello" },
      { role: "ai", text: "hi there" },
      { role: "status", text: "$ git status --short\nM file.ts", kind: "execute" },
      { role: "status", text: "command failed", kind: "error" },
      { role: "status", text: "已恢复后端上下文线程。", kind: "status" },
      { role: "status", text: "$ git status", kind: "command" },
      { role: "user", text: "do something" },
    ];
    const result = buildHistoryInjectionContext(entries);
    assert.ok(result);
    assert.ok(result.includes("User: hello"));
    assert.ok(result.includes("Assistant: hi there"));
    assert.ok(result.includes("Command output: $ git status --short\nM file.ts"));
    assert.ok(result.includes("System error: command failed"));
    assert.ok(!result.includes("已恢复后端上下文线程"));
    assert.ok(!result.includes("Command output: $ git status\n"));
    assert.ok(result.includes("User: do something"));
    assert.ok(result.includes("[Context restore]"));
  });

  it("returns null when no context-bearing entries exist", () => {
    const entries = [
      { role: "status", text: "system started" },
      { role: "command", text: "ls -la" },
      { role: "status", text: "$ git status", kind: "command" },
      { role: "status", text: "已恢复后端上下文线程。", kind: "status" },
    ];
    assert.equal(buildHistoryInjectionContext(entries), null);
  });

  it("returns null for empty entries", () => {
    assert.equal(buildHistoryInjectionContext([]), null);
  });

  it("truncates long entry text", () => {
    const longText = "a".repeat(2000);
    const entries = [{ role: "user", text: longText }];
    const result = buildHistoryInjectionContext(entries);
    assert.ok(result);
    assert.ok(result.length < longText.length);
    assert.ok(result.includes("…"));
  });

  it("limits total transcript length", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "ai",
      text: `message ${i}: ${"x".repeat(400)}`,
    }));
    const result = buildHistoryInjectionContext(entries);
    assert.ok(result);
    assert.ok(result.length <= 10_000);
  });

  it("prepends context to string input", () => {
    const result = prependContextToInput("CONTEXT\n", "user prompt");
    assert.equal(result, "CONTEXT\nuser prompt");
  });

  it("prepends context to array input", () => {
    const result = prependContextToInput("CONTEXT\n", [
      { type: "text", text: "user prompt" },
    ]);
    assert.ok(Array.isArray(result));
    const arr = result as Array<{ type: string; text: string }>;
    assert.equal(arr.length, 2);
    assert.equal(arr[0].text, "CONTEXT\n");
    assert.equal(arr[1].text, "user prompt");
  });
});

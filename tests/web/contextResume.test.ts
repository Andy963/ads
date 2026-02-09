import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryInjectionContext,
  prependContextToInput,
} from "../../src/web/server/ws/handlePrompt.js";

describe("context resume — history injection", () => {
  it("builds transcript from user/ai entries only", () => {
    const entries = [
      { role: "user", text: "hello" },
      { role: "ai", text: "hi there" },
      { role: "status", text: "command ran" },
      { role: "user", text: "do something" },
    ];
    const result = buildHistoryInjectionContext(entries);
    assert.ok(result);
    assert.ok(result.includes("User: hello"));
    assert.ok(result.includes("Assistant: hi there"));
    assert.ok(!result.includes("command ran"));
    assert.ok(result.includes("User: do something"));
    assert.ok(result.includes("[Context restore]"));
  });

  it("returns null when no user/ai entries", () => {
    const entries = [
      { role: "status", text: "system started" },
      { role: "command", text: "ls -la" },
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

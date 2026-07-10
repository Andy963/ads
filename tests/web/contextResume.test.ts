import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryInjectionContext,
  prependContextToInput,
} from "../../server/web/server/ws/handlePrompt.js";
import {
  buildHistoryInjectionDetails,
  parseModelReasoningEffortFromPayload,
} from "../../server/web/server/ws/promptModelConfig.js";

describe("context resume — history injection", () => {
  it("accepts extended Codex reasoning efforts", () => {
    assert.deepEqual(parseModelReasoningEffortFromPayload({ model_reasoning_effort: "max" }), {
      present: true,
      effort: "max",
    });
    assert.deepEqual(parseModelReasoningEffortFromPayload({ model_reasoning_effort: "ultra" }), {
      present: true,
      effort: "ultra",
    });
  });

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

  it("keeps the command and end of long command output entries", () => {
    const commandOutput = [
      `$ npm test`,
      "early output ".repeat(100),
      "Tests: 1 failed, 20 passed",
      "Error: expected recovered context",
      "[exit code 1]",
    ].join("\n");
    const result = buildHistoryInjectionContext([
      { role: "status", kind: "execute", text: commandOutput },
    ]);
    assert.ok(result);
    assert.ok(result.includes("Command output: $ npm test\n…"));
    assert.ok(result.includes("Tests: 1 failed, 20 passed"));
    assert.ok(result.includes("Error: expected recovered context"));
    assert.ok(result.includes("[exit code 1]"));
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

  it("trims long transcript on history entry boundaries", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "ai",
      text: `entry ${i.toString().padStart(2, "0")}: ${"x".repeat(790)}`,
    }));
    const result = buildHistoryInjectionContext(entries);
    assert.ok(result);

    const transcript = result
      .split(
        "[Context restore] Recent chat history (for reference only). Do not repeat it; answer the user's next request directly:\n\n",
      )[1]
      ?.split("\n\n---\n\n")[0];
    assert.ok(transcript);
    const firstLine = transcript.split("\n")[0] ?? "";
    assert.match(firstLine, /^(User|Assistant): entry \d{2}:/);
    assert.ok(!transcript.includes("entry 00:"));
    assert.ok(transcript.includes("entry 19:"));
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

  it("summarizes injection details with entry count and timestamps", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "hi", ts: 100 },
      { role: "ai", text: "hello", ts: 200 },
      { role: "status", text: "$ git status", kind: "command", ts: 250 },
      { role: "status", text: "command failed", kind: "error", ts: 300 },
    ]);
    assert.ok(details);
    assert.equal(details.entryCount, 3);
    assert.equal(details.earliestTs, 100);
    assert.equal(details.latestTs, 300);
    assert.ok(details.text.includes("User: hi"));
    assert.ok(details.text.includes("Assistant: hello"));
    assert.ok(details.text.includes("System error: command failed"));
  });

  it("returns null details when no entries qualify", () => {
    assert.equal(buildHistoryInjectionDetails([]), null);
    assert.equal(
      buildHistoryInjectionDetails([{ role: "status", text: "noise", kind: "status" }]),
      null,
    );
  });
});

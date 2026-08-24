import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHistoryInjectionContext,
  excludeCurrentClientMessage,
  prependContextToInput,
} from "../../server/web/server/ws/handlePrompt.js";
import {
  buildHistoryInjectionDetails,
  parseModelReasoningEffortFromPayload,
} from "../../server/web/server/ws/promptModelConfig.js";
import { PROMPT_ABORTED_MESSAGE } from "../../server/web/server/ws/promptErrorHandling.js";

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
    assert.deepEqual(parseModelReasoningEffortFromPayload({ model_reasoning_effort: "off" }), {
      present: true,
      effort: "off",
    });
    assert.deepEqual(parseModelReasoningEffortFromPayload({ model_reasoning_effort: "minimal" }), {
      present: true,
      effort: "minimal",
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

  it("excludes the current persisted prompt from restored history", () => {
    const entries = [
      { role: "user", text: "earlier", ts: 1, kind: "client_message_id:previous" },
      { role: "ai", text: "earlier reply", ts: 2 },
      { role: "user", text: "current", ts: 3, kind: "client_message_id:current;prompt_meta:model=gpt-4o" },
    ];

    assert.deepEqual(excludeCurrentClientMessage(entries, "current"), entries.slice(0, 2));
  });

  it("truncates long entry text", () => {
    const longText = "a".repeat(3000);
    const entries = [{ role: "user", text: longText }];
    const result = buildHistoryInjectionContext(entries);
    assert.ok(result);
    assert.ok(result.length < longText.length);
    assert.ok(result.includes("…"));
  });

  it("keeps the command and end of long command output entries", () => {
    const commandOutput = [
      `$ npm test`,
      "early output ".repeat(250),
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
    assert.ok(result.length <= 26_000);
  });

  it("trims long transcript on history entry boundaries", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
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
    assert.ok(transcript.includes("entry 49:"));
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

  it("flags a user request that an error interrupted before any reply", () => {
    // Regression: a rate-limited request used to render identically to a completed one, so the
    // "for reference only" framing made the next turn treat it as already handled.
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "rebuild the model settings UI", ts: 100 },
      { role: "status", text: "[rate_limit] too many requests", kind: "error", ts: 200 },
      { role: "user", text: "is it done", ts: 300 },
      { role: "ai", text: "yes, all done", ts: 400 },
    ]);
    assert.ok(details);
    assert.equal(details.unansweredCount, 1);
    assert.ok(details.text.includes("User [UNANSWERED]: rebuild the model settings UI"));
    assert.ok(details.text.includes("User: is it done"));
    assert.ok(details.text.includes("may still be outstanding"));
  });

  it("flags a trailing user turn that never received a reply", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "first", ts: 1 },
      { role: "ai", text: "reply", ts: 2 },
      { role: "user", text: "dropped on disconnect", ts: 3 },
      { role: "status", text: "[unknown] 发生未知错误", kind: "error", ts: 4 },
    ]);
    assert.ok(details);
    assert.equal(details.unansweredCount, 1);
    assert.ok(details.text.includes("User [UNANSWERED]: dropped on disconnect"));
    assert.ok(!details.text.includes("User [UNANSWERED]: first"));
  });

  it("does not treat command output as an assistant reply", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "run the build", ts: 1 },
      { role: "status", text: "$ npm run build\nok", kind: "execute", ts: 2 },
      { role: "user", text: "next", ts: 3 },
      { role: "ai", text: "done", ts: 4 },
    ]);
    assert.ok(details);
    // A slash command answers with status entries and never writes an `ai` entry, so a missing
    // reply alone must not be read as "outstanding" — only an error terminator counts.
    assert.equal(details.unansweredCount, 0);
    assert.ok(!details.text.includes("[UNANSWERED]"));
  });

  it("does not flag a turn the user deliberately interrupted", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "delete the legacy migrations", ts: 1 },
      { role: "status", text: PROMPT_ABORTED_MESSAGE, kind: "error", ts: 2 },
      { role: "user", text: "never mind", ts: 3 },
      { role: "ai", text: "ok", ts: 4 },
    ]);
    assert.ok(details);
    assert.equal(details.unansweredCount, 0);
    assert.ok(!details.text.includes("[UNANSWERED]"));
  });

  it("does not flag a trailing user turn that is merely still running", () => {
    // No error terminator yet — the turn may simply be in flight, so it is not outstanding work.
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "first", ts: 1 },
      { role: "ai", text: "reply", ts: 2 },
      { role: "user", text: "still running", ts: 3 },
    ]);
    assert.ok(details);
    assert.equal(details.unansweredCount, 0);
    assert.ok(!details.text.includes("[UNANSWERED]"));
  });

  it("leaves answered turns unmarked and omits the note entirely", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "hi", ts: 1 },
      { role: "ai", text: "hello", ts: 2 },
      { role: "user", text: "thanks", ts: 3 },
      { role: "ai", text: "welcome", ts: 4 },
    ]);
    assert.ok(details);
    assert.equal(details.unansweredCount, 0);
    assert.ok(!details.text.includes("[UNANSWERED]"));
    assert.ok(!details.text.includes("may still be outstanding"));
  });

  it("counts only unanswered entries that survive transcript trimming", () => {
    // The oldest unanswered request is trimmed away, so the note must not advertise it.
    const entries = [
      { role: "user", text: `dropped long ago: ${"x".repeat(1500)}`, ts: 1 },
      { role: "status", text: "[rate_limit] too many requests", kind: "error", ts: 2 },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "ai",
        text: `entry ${i}: ${"y".repeat(790)}`,
        ts: 10 + i,
      })),
    ];
    const details = buildHistoryInjectionDetails(entries);
    assert.ok(details);
    assert.ok(!details.text.includes("dropped long ago"));
    assert.equal(details.unansweredCount, 0);
    assert.ok(!details.text.includes("[UNANSWERED]"));
  });
});

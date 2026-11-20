import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NativeContextLimitError,
  estimateNativeMessageTokens,
  estimateNativeRequestTokens,
  projectNativeContext,
  resolveNativeContextBudget,
} from "../../server/runtime/nativeContextProjection.js";
import type { NativeChatMessage } from "../../server/runtime/openAiCompatibleClient.js";
import type { NativeToolDefinition } from "../../server/runtime/openAiCompatibleClient.js";

function user(text: string): NativeChatMessage {
  return { role: "user", content: text };
}

function assistant(text: string): NativeChatMessage {
  return { role: "assistant", content: text };
}

describe("native context projection", () => {
  it("uses 256k and 128k only as fallbacks and honors smaller and 1M windows", () => {
    assert.deepEqual(resolveNativeContextBudget(), { contextWindow: 262_144, reservedTokens: 131_072 });
    assert.deepEqual(resolveNativeContextBudget({ contextWindow: 1_048_576, maxOutputTokens: 262_144 }), {
      contextWindow: 1_048_576, reservedTokens: 262_144,
    });
    assert.deepEqual(resolveNativeContextBudget({ contextWindow: 8_192 }), {
      contextWindow: 8_192, reservedTokens: 4_096,
    });
    assert.deepEqual(resolveNativeContextBudget({ contextWindow: 8_192, reservedTokens: 6_000 }), {
      contextWindow: 8_192, reservedTokens: 6_000,
    });
    assert.deepEqual(resolveNativeContextBudget({ contextWindow: 256, reservedTokens: 1_024 }), {
      contextWindow: 256, reservedTokens: 192,
    });
    assert.equal(projectNativeContext([user("x".repeat(100_000))]).diagnostic.compacted, false);
    for (const value of [0, -1, NaN, Infinity, 1.5, 100_000_001]) {
      assert.deepEqual(resolveNativeContextBudget({ contextWindow: value, reservedTokens: value }), {
        contextWindow: 262_144, reservedTokens: 131_072,
      });
    }
  });

  it("calibrates complete-turn selection using prompt usage without lowering the heuristic floor", () => {
    const messages = [user("a".repeat(400)), assistant("b".repeat(400)), user("latest")];
    const options = { contextWindow: 512, reservedTokens: 64 };
    const raw = estimateNativeRequestTokens(messages);
    assert.equal(projectNativeContext(messages, options).messages.length, 3);
    const projection = projectNativeContext(messages, {
      ...options, tokenCalibration: { actualInputTokens: raw * 2, estimatedInputTokens: raw },
    });
    assert.deepEqual(projection.messages, [user("latest")]);
    assert.equal(projection.diagnostic.estimatedTokens, estimateNativeRequestTokens([user("latest")]) * 2);
    assert.equal(projection.diagnostic.droppedMessages, 2);
    for (const actualInputTokens of [1, 0, -1, NaN, Infinity, 0.5]) {
      assert.deepEqual(projectNativeContext(messages, {
        ...options, tokenCalibration: { actualInputTokens, estimatedInputTokens: raw },
      }), projectNativeContext(messages, options));
    }
    assert.deepEqual(projectNativeContext(messages, {
      ...options, tokenCalibration: { actualInputTokens: 800, estimatedInputTokens: 0 },
    }), projectNativeContext(messages, options));
  });

  it("calibrates schemas and truncation together without mutating tool evidence", () => {
    const tools: NativeToolDefinition[] = [{ type: "function", function: {
      name: "read_file", description: "Read a file", parameters: { type: "object" },
    } }];
    const messages: NativeChatMessage[] = [
      user("inspect"),
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "x".repeat(800), tool_call_id: "a" },
    ];
    const original = structuredClone(messages);
    const options = { contextWindow: 512, reservedTokens: 64, tools };
    assert.equal(projectNativeContext(messages, options).diagnostic.compacted, false);
    const projected = projectNativeContext(messages, {
      ...options, tokenCalibration: { actualInputTokens: 201, estimatedInputTokens: 100 },
    });
    assert.equal(projected.diagnostic.truncatedToolOutputs, 1);
    assert.ok(projected.diagnostic.estimatedTokens <= 448);
    assert.equal(projected.diagnostic.estimatedTokens, Math.ceil(estimateNativeRequestTokens(projected.messages, tools) * 2.01));
    assert.deepEqual(messages, original);
    assert.deepEqual(projected.messages.map(message => message.role), ["user", "assistant", "tool"]);
    assert.throws(() => projectNativeContext([user("inspect")], {
      contextWindow: 256, reservedTokens: 64, tools,
      tokenCalibration: { actualInputTokens: 2_000, estimatedInputTokens: 100 },
    }), /tool definitions require/);
  });

  it("keeps complete recent turns and reports older-turn compaction", () => {
    const messages: NativeChatMessage[] = [];
    for (let index = 0; index < 5; index += 1) {
      messages.push(user(`old user ${index} ${"x".repeat(180)}`));
      messages.push(assistant(`old assistant ${index} ${"y".repeat(180)}`));
    }

    const projection = projectNativeContext(messages, {
      contextWindow: 420,
      reservedTokens: 64,
    });

    assert.equal(projection.diagnostic.compacted, true);
    assert.ok(projection.diagnostic.droppedMessages > 0);
    assert.equal(projection.messages.at(-2)?.role, "user");
    assert.equal(projection.messages.at(-1)?.role, "assistant");
    assert.ok(projection.diagnostic.estimatedTokens <= 356);
    assert.deepEqual(messages[0], user(`old user 0 ${"x".repeat(180)}`));
  });

  it("never splits an assistant tool call from its tool result", () => {
    const messages: NativeChatMessage[] = [
      user(`old request ${"x".repeat(600)}`),
      { role: "assistant", content: null, tool_calls: [{ id: "old-call", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "old result", tool_call_id: "old-call" },
      assistant(`old answer ${"y".repeat(600)}`),
      user("current request"),
      { role: "assistant", content: null, tool_calls: [{ id: "current-call", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "current result", tool_call_id: "current-call" },
      assistant("current answer"),
    ];

    const projection = projectNativeContext(messages, {
      contextWindow: 330,
      reservedTokens: 64,
    });

    assert.equal(projection.messages.some((message) => message.role === "tool" && message.tool_call_id === "old-call"), false);
    assert.equal(projection.messages.some((message) => message.role === "tool" && message.tool_call_id === "current-call"), true);
    assert.ok(projection.messages.findIndex((message) => message.role === "tool" && message.tool_call_id === "current-call") > projection.messages.findIndex((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "current-call"));
  });

  it("truncates only projected tool output and preserves the durable message", () => {
    const largeResult = "x".repeat(20_000);
    const messages: NativeChatMessage[] = [
      user("run the tool"),
      { role: "assistant", content: null, tool_calls: [{ id: "large-call", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: largeResult, tool_call_id: "large-call" },
      assistant("done"),
    ];

    const projection = projectNativeContext(messages, {
      contextWindow: 512,
      reservedTokens: 64,
    });
    const projectedTool = projection.messages.find((message) => message.role === "tool");

    assert.equal(projection.diagnostic.truncatedToolOutputs, 1);
    assert.match(String(projectedTool?.content), /Native context truncated: tool output omitted/);
    assert.ok(estimateNativeMessageTokens(projectedTool as NativeChatMessage) < estimateNativeMessageTokens(messages[2] as NativeChatMessage));
    assert.equal(messages[2]?.content, largeResult);
  });

  it("rejects an indivisible non-tool turn that cannot fit", () => {
    assert.throws(
      () => projectNativeContext([user("x".repeat(10_000))], {
        contextWindow: 256,
        reservedTokens: 64,
      }),
      (error: unknown) => error instanceof NativeContextLimitError && error.code === "NATIVE_CONTEXT_LIMIT",
    );
  });

  it("includes tool-definition payload tokens in the input budget", () => {
    const tools: NativeToolDefinition[] = [{
      type: "function",
      function: {
        name: "read_file",
        description: "x".repeat(10_000),
        parameters: { type: "object" },
      },
    }];

    assert.throws(
      () => projectNativeContext([user("request")], {
        contextWindow: 256,
        reservedTokens: 64,
        tools,
      }),
      /tool definitions require/i,
    );
  });

  it("rejects orphaned and incomplete tool chains", () => {
    assert.throws(
      () => projectNativeContext([
        user("request"),
        { role: "tool", content: "orphan", tool_call_id: "missing" },
      ]),
      /tool result .* has no matching tool call/i,
    );
    assert.throws(
      () => projectNativeContext([
        user("request"),
        { role: "assistant", content: null, tool_calls: [{ id: "pending", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      ]),
      /tool results are missing/i,
    );
  });

  it("rejects an unanswered historical user turn before the next user message", () => {
    assert.throws(
      () => projectNativeContext([user("unanswered"), user("next request")]),
      /previous user turn has no assistant response/i,
    );
    assert.deepEqual(projectNativeContext([user("current request")]).messages, [user("current request")]);
  });
});

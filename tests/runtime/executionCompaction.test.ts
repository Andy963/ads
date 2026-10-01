import assert from "node:assert/strict";
import { it } from "node:test";
import { compactExecution } from "../../server/runtime/executionCompaction.js";
import { projectNativeContext, NativeContextLimitError } from "../../server/runtime/nativeContextProjection.js";
import type { NativeChatMessage } from "../../server/runtime/openAiCompatibleClient.js";

function messages(): NativeChatMessage[] {
  const result: NativeChatMessage[] = [{ role: "user", content: "Original task and constraints" }];
  for (let i = 0; i < 70; i++) {
    result.push({ role: "assistant", content: null, tool_calls: [{ type: "function", id: `call-${i}`, function: { name: "read", arguments: "{}" } }],
      nativeResponses: { scope: "scope", output: [{ type: "reasoning", id: `reason-${i}`, summary: [], encrypted_content: `opaque-${i}` }] } });
    result.push({ role: "tool", tool_call_id: `call-${i}`, content: `Evidence ${i}` });
  }
  return result;
}
it("compacts only complete batches and never fabricates Responses replay metadata", async () => {
  const original = messages();
  const preserved = structuredClone(original);
  const compacted = await compactExecution({ messages: original, budget: { contextWindow: 6144, reservedTokens: 1024 }, historyHint: "read_execution_history",
    summarize: async request => {
      projectNativeContext(request);
      assert.match(JSON.stringify(request), /Original task and constraints/);
      return { text: "Decisions, changed paths, verified tests and pending work.", toolCalls: [], usage: null };
    },
  });
  assert.ok(compacted);
  assert.equal(compacted[0]?.content, original[0]?.content);
  assert.equal(compacted[1]?.nativeResponses, undefined);
  assert.deepEqual(compacted.slice(-4), original.slice(-4));
  projectNativeContext(compacted);
  assert.deepEqual(original, preserved);
});
it("does not hide unknown tool outcomes or retry an invalid summary", async () => {
  const unknown = messages();
  unknown[2]!.nativeToolOutcome = "unknown";
  await assert.rejects(compactExecution({ messages: unknown, budget: { contextWindow: 6144, reservedTokens: 1024 }, historyHint: "history", summarize: async () => assert.fail("Must not summarize an unknown outcome") }), NativeContextLimitError);
  let calls = 0;
  await assert.rejects(compactExecution({ messages: messages(), budget: { contextWindow: 6144, reservedTokens: 1024 }, historyHint: "history", summarize: async () => {
    calls++;
    return { text: "partial", toolCalls: [], usage: null, finishReason: "length" };
  } }), NativeContextLimitError);
  assert.equal(calls, 1);
});

it("uses the configured context window rather than a hidden message-count quota", async () => {
  let called = false;
  const compacted = await compactExecution({ messages: messages(), budget: { contextWindow: 1_000_000 }, historyHint: "history",
    summarize: async () => { called = true; return { text: "unused", toolCalls: [], usage: null }; },
  });
  assert.equal(compacted, null);
  assert.equal(called, false);
});

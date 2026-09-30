import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { completeNativeChat, NativeProviderError } from "../../server/runtime/openAiCompatibleClient.js";

const request = {
  baseUrl: "https://provider.test/v1",
  apiKey: "test-key",
  model: "test-model",
  messages: [{ role: "user" as const, content: "Hello" }],
  tools: [],
};

function sse(deltas: Array<{ delta: unknown; finish_reason?: string | null }>): Response {
  return new Response(deltas.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Native optional tool-call fields", () => {
  it("disables tool choice and omits tool-only fields for a tool-free request", async () => {
    let body: Record<string, unknown> | undefined;
    await completeNativeChat({
      ...request, options: { parallelToolCalls: false },
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return sse([{ delta: { content: "Summary" }, finish_reason: "stop" }]);
      },
    });
    assert.equal(body?.tool_choice, "none");
    assert.equal(body?.tools, undefined);
    assert.equal(body?.parallel_tool_calls, undefined);
  });

  for (const empty of [undefined, null, []]) {
    it(`accepts ${JSON.stringify(empty)} tool_calls in text SSE frames`, async () => {
      const snapshots: string[] = [];
      const result = await completeNativeChat({
        ...request,
        fetchImpl: async () => sse([
          { delta: { role: "assistant", content: null, tool_calls: empty }, finish_reason: null },
          { delta: { content: "Hello", tool_calls: empty } },
          { delta: { content: " there", tool_calls: empty } },
          { delta: { content: null, tool_calls: empty }, finish_reason: "stop" },
        ]),
        onTextDelta: text => snapshots.push(text),
      });
      assert.equal(result.text, "Hello there");
      assert.deepEqual(result.toolCalls, []);
      assert.deepEqual(snapshots, ["Hello", "Hello there"]);
    });

    it(`accepts ${JSON.stringify(empty)} tool_calls in non-streaming text`, async () => {
      const result = await completeNativeChat({
        ...request,
        streaming: false,
        fetchImpl: async () => Response.json({ choices: [{
          message: { role: "assistant", content: "Hello", tool_calls: empty }, finish_reason: "stop",
        }] }),
      });
      assert.equal(result.text, "Hello");
      assert.deepEqual(result.toolCalls, []);
    });
  }

  it("retains fragmented tool calls across null placeholders", async () => {
    const result = await completeNativeChat({
      ...request,
      fetchImpl: async () => sse([
        { delta: { content: null, tool_calls: null, function_call: null } },
        { delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: '{"file":' } }] } },
        { delta: { content: null, tool_calls: null, function_call: null } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: '"hello.txt"}' } }] } },
        { delta: { tool_calls: null }, finish_reason: "tool_calls" },
      ]),
    });
    assert.deepEqual(result.toolCalls, [{
      id: "call-1", type: "function", function: { name: "read_file", arguments: '{"file":"hello.txt"}' },
    }]);
  });

  for (const streaming of [true, false]) {
    it(`accepts a null legacy function_call placeholder (streaming=${streaming})`, async () => {
      const message = { content: "Hello", tool_calls: null, function_call: null };
      const result = await completeNativeChat({
        ...request, streaming,
        fetchImpl: async () => streaming
          ? sse([{ delta: message, finish_reason: "stop" }])
          : Response.json({ choices: [{ message, finish_reason: "stop" }] }),
      });
      assert.equal(result.text, "Hello");
    });

    for (const invalid of [{}, "invalid", false, 1, [null]]) {
      it(`rejects invalid tool_calls ${JSON.stringify(invalid)} (streaming=${streaming})`, async () => {
        const message = { content: "Hello", tool_calls: invalid };
        await assert.rejects(completeNativeChat({
          ...request, streaming,
          fetchImpl: async () => streaming
            ? sse([{ delta: message, finish_reason: "stop" }])
            : Response.json({ choices: [{ message, finish_reason: "stop" }] }),
        }), error => error instanceof NativeProviderError && error.kind === "malformed");
      });
    }

    it(`rejects a tool-call finish without calls (streaming=${streaming})`, async () => {
      await assert.rejects(completeNativeChat({
        ...request, streaming,
        fetchImpl: async () => streaming
          ? sse([{ delta: { tool_calls: null }, finish_reason: "tool_calls" }])
          : Response.json({ choices: [{ message: { tool_calls: null }, finish_reason: "tool_calls" }] }),
      }), error => error instanceof NativeProviderError && error.kind === "malformed");
    });
  }
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import {
  DEFAULT_NATIVE_PROVIDER_CAPABILITIES,
  NativeCapabilityError,
  resolveNativeProviderCapabilities,
} from "../../server/runtime/nativeProviderCapabilities.js";
import {
  completeNativeChat,
  type NativeChatMessage,
} from "../../server/runtime/openAiCompatibleClient.js";

const messages: NativeChatMessage[] = [{ role: "user", content: "hello" }];

describe("native provider capabilities", () => {
  it("exposes independent supported, unsupported, and unknown states", () => {
    const capabilities = resolveNativeProviderCapabilities({
      streaming: "unsupported",
      structuredOutput: true,
      supportsReasoningEffort: false,
      imageInput: "supported",
    });

    assert.equal(capabilities.streaming, "unsupported");
    assert.equal(capabilities.nonStreaming, DEFAULT_NATIVE_PROVIDER_CAPABILITIES.nonStreaming);
    assert.equal(capabilities.structuredOutput, "supported");
    assert.equal(capabilities.reasoningEffort, "unsupported");
    assert.equal(capabilities.imageInput, "supported");
  });

  it("sends non-streaming requests without delta callbacks", async () => {
    let body: Record<string, unknown> | undefined;
    let accept = "";
    let deltaCalls = 0;
    const result = await completeNativeChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
      model: "test-model",
      messages,
      tools: [],
      streaming: false,
      fetchImpl: async (_input, init) => {
        accept = String((init?.headers && new Headers(init.headers).get("accept")) ?? "");
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "complete" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }), { headers: { "content-type": "application/json" } });
      },
      onTextDelta: () => {
        deltaCalls += 1;
      },
    });

    assert.equal(result.text, "complete");
    assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
    assert.equal(body?.stream, false);
    assert.equal(body?.stream_options, undefined);
    assert.equal(accept, "application/json");
    assert.equal(deltaCalls, 0);
  });

  it("omits usage requests when the provider capability is not supported", async () => {
    let body: Record<string, unknown> | undefined;
    await completeNativeChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
      model: "test-model",
      messages,
      tools: [],
      options: { includeUsage: false },
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(body?.stream_options, undefined);
  });

  it("passes a configured JSON schema as response_format", async () => {
    let body: Record<string, unknown> | undefined;
    await completeNativeChat({
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
      model: "test-model",
      messages,
      tools: [],
      streaming: false,
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.deepEqual(body?.response_format, {
      type: "json_schema",
      json_schema: {
        name: "ads_output",
        strict: true,
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
  });

  it("rejects malformed non-streaming responses", async () => {
    await assert.rejects(
      completeNativeChat({
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key",
        model: "test-model",
        messages,
        tools: [],
        streaming: false,
        fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), {
          headers: { "content-type": "application/json" },
        }),
      }),
      /without choices/i,
    );
  });

  it("exposes a stable capability error code", () => {
    const error = new NativeCapabilityError("imageInput");
    assert.equal(error.code, "NATIVE_CAPABILITY_UNSUPPORTED");
    assert.match(error.message, /imageInput/);
  });

  it("uses the adapter contract to reject unsupported structured output and images", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-capabilities-"));
    try {
      let fetchCalls = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
          }),
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ choices: [{ message: { content: "unused" }, finish_reason: "stop" }] }), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await assert.rejects(
        adapter.send("return json", { outputSchema: { type: "object" } }),
        /structuredOutput/,
      );
      await assert.rejects(
        adapter.send([{ type: "local_image", path: "/tmp/image.png" }]),
        /imageInput/,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects tool execution when tool calls are not supported", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-capabilities-tools-"));
    try {
      let fetchCalls = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
            capabilities: { toolCalls: "unsupported" },
          }),
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      });

      await assert.rejects(adapter.send("hello"), /toolCalls/);
      assert.equal(fetchCalls, 0);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requests single-tool behavior when parallel calls are unsupported", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-capabilities-parallel-"));
    try {
      let body: Record<string, unknown> | undefined;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
            capabilities: { parallelToolCalls: "unsupported" },
          }),
        },
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await adapter.send("hello", { streaming: false });
      assert.equal(body?.parallel_tool_calls, false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not emit partial snapshots when the adapter disables streaming", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-capabilities-nonstream-"));
    try {
      let body: Record<string, unknown> | undefined;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
            capabilities: { nonStreaming: "supported" },
          }),
        },
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response(JSON.stringify({
            choices: [{ message: { content: "complete" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }), { headers: { "content-type": "application/json" } });
        },
      });
      const partialSnapshots: string[] = [];
      adapter.onEvent((event) => {
        const item = (event.raw as { type?: string; item?: { type?: string } }).item;
        if (event.raw.type === "item.updated" && item?.type === "agent_message") {
          partialSnapshots.push("snapshot");
        }
      });

      const result = await adapter.send("hello", { streaming: false });

      assert.equal(result.response, "complete");
      assert.equal(body?.stream, false);
      assert.deepEqual(partialSnapshots, []);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { AgentAdapter } from "../../server/agents/types.js";
import { CodexAppServerClient } from "../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../server/codex/appServer/daemonRegistry.js";
import { isNativeExecutionId } from "../../server/runtime/sessionIdentity.js";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function createCodexTestServer(): {
  client: CodexAppServerClient;
  notify: (method: string, params: Record<string, unknown>) => void;
  requests: Array<{ method?: string; params?: any }>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr, waitClose: async () => null });
  const requests: Array<{ method?: string; params?: any }> = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: any };
      requests.push(message);
      const result = message.method === "thread/start"
        ? { thread: { id: "contract-thread" } }
        : {};
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    }
  });
  return {
    client,
    requests,
    notify: (method, params) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
  };
}

function assertSharedAgentAdapterContract(adapter: AgentAdapter): void {
  assert.equal(adapter.id, "codex");
  assert.equal(adapter.status().ready, true);
  assert.equal(typeof adapter.send, "function");
  assert.equal(typeof adapter.onEvent, "function");
  assert.equal(typeof adapter.reset, "function");
  assert.deepEqual(
    adapter.metadata.capabilities.filter((capability) => ["text", "files", "commands"].includes(capability)),
    ["text", "files", "commands"],
  );

  let eventCount = 0;
  const unsubscribe = adapter.onEvent(() => {
    eventCount += 1;
  });
  unsubscribe();
  assert.equal(eventCount, 0);

  adapter.setModel?.("contract-model");
  adapter.setModelReasoningEffort?.("medium");
  adapter.reset();
}

describe("shared AgentAdapter contract", () => {
  it("exposes the same lifecycle surface for Codex and Native adapters", () => {
    const codex = new CodexAppServerAdapter({ projectId: "contract-codex" });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-adapter-contract-"));
    try {
      const native = new NativeAgentAdapter({
        credentialOwner: "contract-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "contract-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
          }),
        },
      });

      assertSharedAgentAdapterContract(codex);
      assertSharedAgentAdapterContract(native);
      assert.equal(codex.getThreadId(), null);
      assert.equal(isNativeExecutionId(native.getThreadId()), true);
      assert.notEqual(codex.getThreadId(), native.getThreadId());
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs a Codex turn with final response, usage, and lifecycle events", async () => {
    const server = createCodexTestServer();
    const registry = new CodexAppServerDaemonRegistry({ factory: () => server.client });
    const adapter = new CodexAppServerAdapter({ projectId: "contract-codex-turn", registry });
    const events: string[] = [];
    adapter.onEvent((event) => events.push(`${event.phase}:${event.title}`));
    const pending = adapter.send("contract turn");
    await new Promise((resolve) => setTimeout(resolve, 30));

    server.notify("thread/started", { thread: { id: "contract-thread" } });
    server.notify("turn/started", { threadId: "contract-thread", turn: { id: "contract-turn" } });
    server.notify("item/completed", {
      item: { type: "agentMessage", id: "contract-message", text: "contract response" },
      threadId: "contract-thread",
      turnId: "contract-turn",
    });
    server.notify("turn/completed", {
      threadId: "contract-thread",
      turn: { id: "contract-turn", usage: { input_tokens: 2, output_tokens: 3 } },
      usage: { input_tokens: 2, output_tokens: 3 },
    });

    const result = await pending;
    assert.equal(result.response, "contract response");
    assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
    assert.ok(events.some((event) => event.startsWith("responding:")));
    assert.ok(events.some((event) => event.startsWith("completed:")));
    assert.ok(server.requests.some((request) => request.method === "turn/start"));
    await registry.stopAll();
  });

  it("runs a Native turn with final response, usage, and lifecycle events", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-contract-"));
    try {
      const adapter = new NativeAgentAdapter({
        credentialOwner: "contract-owner",
        workspaceRoot: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-key",
            provider: "test",
          }),
        },
        fetchImpl: async () => jsonResponse({
          choices: [{ message: { content: "native response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        }),
      });
      const events: string[] = [];
      adapter.onEvent((event) => events.push(`${event.phase}:${event.title}`));

      const result = await adapter.send("contract turn", { streaming: false });

      assert.equal(result.response, "native response");
      assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 3, total_tokens: 7 });
      assert.ok(events.some((event) => event.startsWith("responding:")));
      assert.ok(events.some((event) => event.startsWith("completed:")));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

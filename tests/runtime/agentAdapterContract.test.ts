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

function sseResponse(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function sseEventsResponse(payloads: unknown[]): Response {
  return new Response(`${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function assertTurnContractResult(
  result: Awaited<ReturnType<AgentAdapter["send"]>>,
  events: string[],
): void {
  assert.equal(result.response, "contract response");
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  assert.ok(events.some((event) => event.startsWith("responding:")));
  assert.ok(events.some((event) => event.startsWith("completed:")));
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
      turn: { id: "contract-turn", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });

    const result = await pending;
    assertTurnContractResult(result, events);
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
        fetchImpl: async () => sseResponse({
          choices: [{ delta: { content: "contract response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      });
      const events: string[] = [];
      adapter.onEvent((event) => events.push(`${event.phase}:${event.title}`));

      const result = await adapter.send("contract turn", { streaming: true });

      assertTurnContractResult(result, events);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("cancels in-flight turns for both backends", async () => {
    const server = createCodexTestServer();
    const registry = new CodexAppServerDaemonRegistry({ factory: () => server.client });
    const codex = new CodexAppServerAdapter({ projectId: "contract-codex-cancel", registry });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-contract-cancel-"));
    try {
      const native = new NativeAgentAdapter({
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
        fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
          }, { once: true });
        }),
      });
      const codexController = new AbortController();
      const codexPending = codex.send("cancelled", { signal: codexController.signal });
      await new Promise((resolve) => setTimeout(resolve, 30));
      server.notify("thread/started", { thread: { id: "contract-thread" } });
      server.notify("turn/started", { threadId: "contract-thread", turn: { id: "cancelled-turn" } });
      codexController.abort();
      await assert.rejects(codexPending, /abort|interrupt|cancel/i);

      const nativeController = new AbortController();
      const nativePending = native.send("cancelled", { signal: nativeController.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      nativeController.abort();
      await assert.rejects(nativePending, /abort|interrupt|cancel/i);
      await registry.stopAll();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves structured command and file-change events for both backends", async () => {
    const server = createCodexTestServer();
    const registry = new CodexAppServerDaemonRegistry({ factory: () => server.client });
    const codex = new CodexAppServerAdapter({ projectId: "contract-codex-events", registry });
    const codexEvents: Array<{ phase: string; rawType?: string }> = [];
    codex.onEvent((event) => {
      const item = (event.raw as { item?: { type?: string } }).item;
      codexEvents.push({ phase: event.phase, rawType: item?.type });
    });
    const codexPending = codex.send("change files");
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.notify("thread/started", { thread: { id: "contract-thread" } });
    server.notify("turn/started", { threadId: "contract-thread", turn: { id: "events-turn" } });
    server.notify("item/started", {
      item: { type: "commandExecution", command: "git status", status: "in_progress" },
      threadId: "contract-thread",
      turnId: "events-turn",
    });
    server.notify("item/completed", {
      item: { type: "fileChange", changes: [{ kind: "update", path: "README.md" }] },
      threadId: "contract-thread",
      turnId: "events-turn",
    });
    server.notify("turn/completed", { threadId: "contract-thread", turn: { id: "events-turn" } });
    await codexPending;
    assert.ok(codexEvents.some((event) => event.phase === "command" && event.rawType === "command_execution"));
    assert.ok(codexEvents.some((event) => event.phase === "editing" && event.rawType === "file_change"));
    await registry.stopAll();

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-contract-events-"));
    try {
      let request = 0;
      const native = new NativeAgentAdapter({
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
        fetchImpl: async () => {
          request += 1;
          if (request === 1) {
            return sseEventsResponse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: "native-command", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "process.stdout.write('command-ok')"] }) } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ]);
          }
          if (request === 2) {
            return sseEventsResponse([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: "native-patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patch: "*** Begin Patch\n*** Add File: contract.txt\n+ok\n*** End Patch" }) } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ]);
          }
          return sseResponse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] });
        },
      });
      const nativeEvents: Array<{ phase: string; rawType?: string }> = [];
      native.onEvent((event) => {
        const item = (event.raw as { item?: { type?: string } }).item;
        nativeEvents.push({ phase: event.phase, rawType: item?.type });
      });
      await native.send("change files");
      assert.ok(nativeEvents.some((event) => event.phase === "command" && event.rawType === "command_execution"));
      assert.ok(nativeEvents.some((event) => event.phase === "editing" && event.rawType === "file_change"));
      assert.equal(fs.readFileSync(path.join(workspace, "contract.txt"), "utf8"), "ok\n");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces terminal failures for both backends", async () => {
    const server = createCodexTestServer();
    const registry = new CodexAppServerDaemonRegistry({ factory: () => server.client });
    const codex = new CodexAppServerAdapter({ projectId: "contract-codex-failure", registry });
    const codexEvents: string[] = [];
    codex.onEvent((event) => codexEvents.push(`${event.phase}:${event.detail ?? ""}`));
    const codexPending = codex.send("fail");
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.notify("thread/started", { thread: { id: "contract-thread" } });
    server.notify("turn/started", { threadId: "contract-thread", turn: { id: "failed-turn" } });
    server.notify("error", { message: "contract failure" });
    await assert.rejects(codexPending, /contract failure/);
    assert.ok(codexEvents.some((event) => event.startsWith("error:")));
    await registry.stopAll();

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-contract-failure-"));
    try {
      const native = new NativeAgentAdapter({
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
        fetchImpl: async () => new Response("provider failed", { status: 400 }),
      });
      const nativeEvents: Array<{ phase: string; detail?: string; rawType?: string }> = [];
      native.onEvent((event) => {
        const raw = event.raw as { type?: string; error?: { message?: string } };
        nativeEvents.push({ phase: event.phase, detail: event.detail, rawType: raw.type });
      });
      await assert.rejects(native.send("fail"), /provider|upstream|400/i);
      assert.ok(nativeEvents.some((event) => (
        event.phase === "error"
        && event.rawType === "turn.failed"
        && /provider|upstream|400/i.test(event.detail ?? "")
      )));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

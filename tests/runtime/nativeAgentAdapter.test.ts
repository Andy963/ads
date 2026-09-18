import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { NativeModelResolver } from "../../server/runtime/modelResolver.js";

function sse(events: string[]): Response {
  return new Response(`${events.map((event) => `data: ${event}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("NativeAgentAdapter", () => {
  it("streams a text response and completes a read_file tool round", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-"));
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello from the workspace\n", "utf8");
      const requests: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
      let requestNumber = 0;
      const resolver: NativeModelResolver = {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-api-key",
          provider: "test",
        }),
      };
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string | null }> };
          requests.push({ messages: body.messages ?? [] });
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-1", function: { name: "read_file", arguments: '{"file":"hello.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "The file says hello." } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
          ]);
        },
      });
      const events: string[] = [];
      let completedUsage: unknown;
      adapter.onEvent((event) => {
        events.push(`${event.phase}:${event.title}`);
        if (event.raw.type === "turn.completed") completedUsage = event.raw.usage;
      });

      const result = await adapter.send("Inspect the file");

      assert.equal(result.response, "The file says hello.");
      assert.deepEqual(result.usage, { input_tokens: 15, output_tokens: 9, total_tokens: 24 });
      assert.deepEqual(completedUsage, { input_tokens: 15, output_tokens: 9, total_tokens: 24 });
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.messages.at(-1)?.role, "tool");
      assert.ok(events.some((event) => event.startsWith("boot:")));
      assert.ok(events.some((event) => event.startsWith("tool:")));
      assert.ok(events.some((event) => event.startsWith("responding:")));
      assert.ok(events.some((event) => event.startsWith("completed:")));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps streamed text snapshots isolated across tool-call rounds", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-snapshots-"));
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n", "utf8");
      let requestNumber = 0;
      const resolver: NativeModelResolver = {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-api-key",
          provider: "test",
        }),
      };
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({ choices: [{ delta: { content: "First round", tool_calls: [{ index: 0, id: "read-1", function: { name: "read_file", arguments: '{"file":"hello.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Second round" } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          ]);
        },
      });
      const snapshots: string[] = [];
      adapter.onEvent((event) => {
        if (event.phase === "responding" && event.delta) snapshots.push(event.delta);
      });

      const result = await adapter.send("Inspect the file");

      assert.equal(result.response, "First roundSecond round");
      assert.deepEqual(snapshots, ["First round", "Second round"]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns tool failures to the model so a later round can recover", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-recovery-"));
    try {
      let requestNumber = 0;
      let recoveryMessages: Array<{ role: string; content: string | null }> = [];
      const resolver: NativeModelResolver = {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-api-key",
          provider: "test",
          supportsReasoningEffort: false,
        }),
      };
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string | null }> };
          requestNumber += 1;
          if (requestNumber === 2) recoveryMessages = body.messages ?? [];
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "missing-1", function: { name: "read_file", arguments: '{"file":"missing.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Recovered after the tool error." } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          ]);
        },
      });
      const rawEvents: string[] = [];
      adapter.onEvent((event) => rawEvents.push(event.raw.type));

      const result = await adapter.send("Inspect the missing file");

      assert.equal(result.response, "Recovered after the tool error.");
      assert.equal(requestNumber, 2);
      assert.equal(recoveryMessages.at(-1)?.role, "tool");
      assert.match(recoveryMessages.at(-1)?.content ?? "", /Path does not exist/);
      assert.equal(rawEvents.includes("turn.failed"), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("completes with a continuation notice at the tool-round limit", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-limit-"));
    try {
      let requestNumber = 0;
      const resolver: NativeModelResolver = {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-api-key",
          provider: "test",
          supportsReasoningEffort: false,
        }),
      };
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        maxToolRounds: 1,
        fetchImpl: async () => {
          requestNumber += 1;
          return sse([
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "limit-1", function: { name: "read_file", arguments: '{"file":"missing.txt"}' } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]);
        },
      });
      const rawEvents: string[] = [];
      adapter.onEvent((event) => rawEvents.push(event.raw.type));

      const result = await adapter.send("Inspect the missing file");

      assert.match(result.response, /tool-round limit/);
      assert.equal(requestNumber, 1);
      assert.equal(rawEvents.includes("turn.completed"), true);
      assert.equal(rawEvents.includes("turn.failed"), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("omits reasoning_effort for models without explicit reasoning support", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-reasoning-"));
    try {
      let requestBody: Record<string, unknown> | null = null;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelReasoningEffort: "high",
        modelResolver: {
          resolve: () => ({
            model: "gpt-4o",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
            options: { reasoningEffort: "high" },
            supportsReasoningEffort: false,
          }),
        },
        fetchImpl: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return sse([JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })]);
        },
      });

      await adapter.send("hello");

      assert.equal(requestBody?.reasoning_effort, undefined);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("includes reasoning_effort for models with explicit reasoning support", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-reasoning-supported-"));
    try {
      let requestBody: Record<string, unknown> | null = null;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        modelReasoningEffort: "high",
        modelResolver: {
          resolve: () => ({
            model: "reasoning-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
            supportsReasoningEffort: true,
          }),
        },
        fetchImpl: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return sse([JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })]);
        },
      });

      await adapter.send("hello");

      assert.equal(requestBody?.reasoning_effort, "high");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("propagates aborts from a running tool without starting another upstream round", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-abort-"));
    const controller = new AbortController();
    let requestNumber = 0;
    try {
      const resolver: NativeModelResolver = {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-api-key",
          provider: "test",
        }),
      };
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        fetchImpl: async () => {
          requestNumber += 1;
          setTimeout(() => controller.abort(), 50);
          return sse([
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "exec-1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 120_000 }) } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]);
        },
      });

      await assert.rejects(
        adapter.send("Run the command", { signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(requestNumber, 1);
    } finally {
      controller.abort();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("redacts the API key from upstream failures", async () => {
    const resolver: NativeModelResolver = {
      resolve: () => ({
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "secret-api-key",
        provider: "test",
      }),
    };
    const adapter = new NativeAgentAdapter({
      credentialOwner: "test-owner",
      workspaceRoot: process.cwd(),
      modelResolver: resolver,
      fetchImpl: async () => new Response("secret-api-key upstream failure", { status: 401 }),
    });

    await assert.rejects(adapter.send("hello"), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /redacted/);
      assert.doesNotMatch(error.message, /secret-api-key/);
      return true;
    });
  });
});

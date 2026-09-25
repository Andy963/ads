import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { NativeModelResolver } from "../../server/runtime/modelResolver.js";
import type { NativeChatMessage } from "../../server/runtime/openAiCompatibleClient.js";
import {
  getStateDatabase,
  resetStateDatabaseForTests,
} from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";
import { ActivityTracker } from "../../server/utils/activityTracker.js";

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
      const events: Array<{ key: string; liveStep?: boolean; delta?: string; rawItemType?: string }> = [];
      let completedUsage: unknown;
      adapter.onEvent((event) => {
        const rawItem = (event.raw as { item?: { type?: string } }).item;
        events.push({
          key: `${event.phase}:${event.title}`,
          liveStep: event.liveStep,
          delta: event.delta,
          rawItemType: rawItem?.type,
        });
        if (event.raw.type === "turn.completed") completedUsage = event.raw.usage;
      });

      const result = await adapter.send("Inspect the file");

      assert.equal(result.response, "The file says hello.");
      assert.deepEqual(result.usage, { input_tokens: 15, output_tokens: 9, total_tokens: 24 });
      assert.deepEqual(completedUsage, { input_tokens: 15, output_tokens: 9, total_tokens: 24 });
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.messages.at(-1)?.role, "tool");
      assert.ok(events.some((event) => event.key.startsWith("boot:")));
      assert.equal(events.some((event) => event.liveStep === true), false);
      assert.ok(events.some((event) => event.key.startsWith("responding:")));
      assert.ok(events.some((event) => event.key.startsWith("completed:")));
      // Internal tool mechanics stay silent: no raw tool_call items reach consumers.
      assert.equal(events.some((event) => event.key.startsWith("tool:")), false);
      assert.equal(events.some((event) => event.rawItemType === "tool_call"), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("emits no live steps while preserving structured tool artifacts", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-live-steps-"));
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello from the workspace\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: hello.txt",
        "@@",
        "-hello from the workspace",
        "+hello patched",
        "*** End Patch",
      ].join("\n");
      const toolCalls = [
        { id: "read-1", name: "read_file", arguments: JSON.stringify({ file: "hello.txt" }) },
        { id: "search-1", name: "search", arguments: JSON.stringify({ pattern: "hello" }) },
        { id: "patch-1", name: "apply_patch", arguments: JSON.stringify({ patch }) },
        { id: "exec-1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo", args: ["hi"] }) },
      ];
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
          const call = toolCalls[requestNumber - 1];
          if (call) {
            return sse([
              JSON.stringify({
                choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: call.arguments } }] } }],
              }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "All done." }, finish_reason: "stop" }] }),
          ]);
        },
      });
      const liveSteps: string[] = [];
      const rawItemTypes: string[] = [];
      adapter.onEvent((event) => {
        if (event.liveStep === true) liveSteps.push(String(event.delta ?? ""));
        const rawItem = (event.raw as { item?: { type?: string } }).item;
        if (rawItem?.type) rawItemTypes.push(rawItem.type);
      });

      const result = await adapter.send("Inspect, search, patch, and run");

      assert.equal(result.response, "All done.");
      assert.deepEqual(liveSteps, []);
      // Command execution blocks and patch cards still render via their own items.
      assert.equal(rawItemTypes.filter((type) => type === "command_execution").length, 2);
      assert.ok(rawItemTypes.includes("file_change"));
      // Raw tool_call items never reach consumers (no `- **Tool: native.*` leaks).
      assert.equal(rawItemTypes.includes("tool_call"), false);
      assert.equal(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8"), "hello patched\n");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps internal native tool activity out of ActivityTracker explored entries", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-explored-"));
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello from the workspace\n", "utf8");
      let requestNumber = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-1", function: { name: "read_file", arguments: '{"file":"hello.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "The file says hello." }, finish_reason: "stop" }] }),
          ]);
        },
      });
      const tracker = new ActivityTracker();
      adapter.onEvent((event) => tracker.ingestThreadEvent(event.raw));

      const result = await adapter.send("Inspect the file");

      assert.equal(result.response, "The file says hello.");
      const entries = tracker.compact({ maxItems: 20, dedupe: "none" });
      assert.deepEqual(entries, []);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("dispatches action jobs without emitting a live step", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-dispatch-"));
    try {
      let requestNumber = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: "dispatch-1",
                      function: {
                        name: "dispatch_action_job",
                        arguments: JSON.stringify({ issue_id: 277, title: "Refactor dual lanes" }),
                      },
                    }],
                  },
                }],
              }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Job dispatched successfully." }, finish_reason: "stop" }] }),
          ]);
        },
      });

      const liveSteps: string[] = [];
      adapter.onEvent((event) => {
        if (event.liveStep === true) liveSteps.push(String(event.delta ?? ""));
      });

      const result = await adapter.send("Please dispatch issue 277 to Actions");

      assert.equal(result.response, "Job dispatched successfully.");
      assert.deepEqual(liveSteps, []);
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

  it("continues through many tool rounds when no explicit limit is configured", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-unlimited-"));
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n", "utf8");
      const toolRounds = 20;
      let requestNumber = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        env: {
          ADS_AGENT_MAX_TOOL_ROUNDS: undefined,
          ADS_NATIVE_RUNTIME_MAX_TOOL_ROUNDS: undefined,
        },
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber <= toolRounds) {
            return sse([
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: `read-${requestNumber}`,
                      function: { name: "read_file", arguments: '{"file":"hello.txt"}' },
                    }],
                  },
                }],
              }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Completed after many rounds" }, finish_reason: "stop" }] }),
          ]);
        },
      });

      const result = await adapter.send("Inspect the file repeatedly");

      assert.equal(result.response, "Completed after many rounds");
      assert.equal(requestNumber, toolRounds + 1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts both native runtime round-limit environment variables", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-env-limit-"));
    try {
      for (const env of [
        { ADS_AGENT_MAX_TOOL_ROUNDS: "1", ADS_NATIVE_RUNTIME_MAX_TOOL_ROUNDS: undefined },
        { ADS_AGENT_MAX_TOOL_ROUNDS: undefined, ADS_NATIVE_RUNTIME_MAX_TOOL_ROUNDS: "1" },
      ]) {
        let requestNumber = 0;
        const adapter = new NativeAgentAdapter({
          credentialOwner: "test-owner",
          workspaceRoot: workspace,
          env,
          modelResolver: {
            resolve: () => ({
              model: "test-model",
              baseUrl: "https://provider.test/v1",
              apiKey: "test-api-key",
              provider: "test",
            }),
          },
          fetchImpl: async () => {
            requestNumber += 1;
            return sse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "env-limit-1", function: { name: "read_file", arguments: '{"file":"missing.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          },
        });

        const result = await adapter.send("Inspect the missing file");

        assert.match(result.response, /tool-round limit/);
        assert.equal(requestNumber, 1);
      }
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

  it("redacts short secret-shaped environment values only in credential contexts", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-short-secret-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-short-secret-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-short-secret";
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    try {
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        transcriptId,
        transcriptStore: store,
        env: { SHORT_SECRET: "q", PATH_SEPARATOR: "/" },
        fetchImpl: async () => sse([
          JSON.stringify({
            choices: [{
              delta: { content: "SHORT_SECRET=q and PATH_SEPARATOR=/" },
              finish_reason: "stop",
            }],
          }),
        ]),
      });
      await adapter.send("short secret");
      const raw = JSON.stringify(
        getStateDatabase(dbPath)
          .prepare("SELECT messages_json, entries_json FROM native_transcript_turns")
          .all(),
      );
      assert.doesNotMatch(raw, /SHORT_SECRET=q/);
      assert.doesNotMatch(raw, /PATH_SEPARATOR=\//);
      assert.match(raw, /\[redacted\]/);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("restores completed Native transcripts without persisting execution ids or secrets", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-restore-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-restore";
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const resolver: NativeModelResolver = {
      resolve: () => ({
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "secret-api-key",
        provider: "test",
      }),
    };

    try {
      let firstRequest = 0;
      const firstAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        env: {
          ADS_WEB_SESSION_PEPPER: "session-pepper-value",
          NATIVE_TEST_SECRET: "environment-secret",
        },
        fetchImpl: async () => {
          firstRequest += 1;
          if (firstRequest === 1) {
            return sse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "exec-1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "process.stdout.write(process.env.ADS_WEB_SESSION_PEPPER ?? '')"] }) } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
          ]);
        },
      });

      await firstAdapter.send("secret-api-key environment-secret");
      const executionId = firstAdapter.getThreadId();
      assert.ok(executionId);
      const turns = store.listTurns(transcriptId);
      assert.equal(turns[0]?.status, "completed");
      assert.deepEqual(turns[0]?.entries.map((entry) => entry.kind), [
        "message",
        "message",
        "command",
        "message",
        "message",
      ]);
      const rawRows = getStateDatabase(dbPath)
        .prepare("SELECT * FROM native_transcript_turns")
        .all();
      const raw = JSON.stringify(rawRows);
      assert.doesNotMatch(raw, /secret-api-key/);
      assert.doesNotMatch(raw, /environment-secret/);
      assert.doesNotMatch(raw, /session-pepper-value/);
      assert.doesNotMatch(raw, new RegExp(executionId ?? "native-execution-id"));

      firstAdapter.reset();

      let restoredRequest: { messages?: Array<{ role: string; content: string | null }> } | undefined;
      const restoredAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        env: {
          ADS_WEB_SESSION_PEPPER: "session-pepper-value",
          NATIVE_TEST_SECRET: "environment-secret",
        },
        fetchImpl: async (_input, init) => {
          restoredRequest = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string | null }> };
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] }),
          ]);
        },
      });

      await restoredAdapter.send("next");
      assert.deepEqual(restoredRequest?.messages?.map((message) => message.role), [
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
      ]);
      assert.equal(restoredRequest?.messages?.[0]?.content?.includes("secret-api-key"), false);
      assert.equal(restoredRequest?.messages?.[0]?.content?.includes("environment-secret"), false);
      assert.equal(restoredRequest?.messages?.[2]?.content?.includes("session-pepper-value"), false);
      assert.notEqual(restoredAdapter.getThreadId(), executionId);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("restores every completed message without splitting a trailing tool chain", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-full-restore-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-full-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-full-restore";
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const restoredMessages: NativeChatMessage[] = [];
    for (let index = 0; index < 100; index += 1) {
      restoredMessages.push({ role: "user", content: `user-${index}` });
      restoredMessages.push({ role: "assistant", content: `assistant-${index}` });
    }
    restoredMessages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tail-call", type: "function", function: { name: "exec_command", arguments: "{}" } }],
      },
      { role: "tool", content: "tail-result", tool_call_id: "tail-call" },
    );
    store.beginTurn({
      transcriptId,
      turnId: "long-turn",
      messages: restoredMessages,
      entries: restoredMessages.map((message) => ({ kind: "message" as const, message })),
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "long-turn",
      status: "completed",
      messages: restoredMessages,
      entries: restoredMessages.map((message) => ({ kind: "message" as const, message })),
      usage: null,
    });

    try {
      let requestMessages: Array<{ role: string; content?: string | null; tool_call_id?: string }> = [];
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        transcriptId,
        transcriptStore: store,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            messages?: Array<{ role: string; content?: string | null; tool_call_id?: string }>;
          };
          requestMessages = body.messages ?? [];
          return sse([JSON.stringify({ choices: [{ delta: { content: "continued" }, finish_reason: "stop" }] })]);
        },
      });

      await adapter.send("next");
      assert.equal(requestMessages.length, 203);
      assert.deepEqual(requestMessages[0], { role: "user", content: "user-0" });
      assert.equal(requestMessages[200]?.role, "assistant");
      assert.deepEqual(requestMessages[201], { role: "tool", content: "tail-result", tool_call_id: "tail-call" });
      assert.deepEqual(requestMessages[202], { role: "user", content: "next" });
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves active checkpoint identity across a non-destructive runtime disposal", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-active-reset-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-active-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-active-reset";

    class ResetDuringCheckpointStore extends NativeTranscriptStore {
      onRunningCheckpoint: (() => void) | undefined;
      private triggered = false;

      override updateTurn(input: Parameters<NativeTranscriptStore["updateTurn"]>[0]): void {
        super.updateTurn(input);
        if (input.status === "running" && !this.triggered) {
          this.triggered = true;
          this.onRunningCheckpoint?.();
        }
      }
    }

    const store = new ResetDuringCheckpointStore(getStateDatabase(dbPath));
    try {
      let requestNumber = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        transcriptId,
        transcriptStore: store,
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: "exec-1",
                      function: {
                        name: "exec_command",
                        arguments: JSON.stringify({ cmd: "echo", args: ["safe"] }),
                      },
                    }],
                  },
                }],
              }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })]);
        },
      });
      store.onRunningCheckpoint = () => adapter.reset();

      const result = await adapter.send("run a tool");
      assert.equal(result.response, "done");
      const turns = store.listTurns(transcriptId);
      assert.equal(turns.length, 1);
      assert.equal(turns[0]?.status, "completed");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an in-flight turn after a destructive reset", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-destructive-reset-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-destructive-reset-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-destructive-reset";

    class ResetDuringCheckpointStore extends NativeTranscriptStore {
      onRunningCheckpoint: (() => void) | undefined;
      private triggered = false;

      override updateTurn(input: Parameters<NativeTranscriptStore["updateTurn"]>[0]): void {
        super.updateTurn(input);
        if (input.status === "running" && !this.triggered) {
          this.triggered = true;
          this.onRunningCheckpoint?.();
        }
      }
    }

    const store = new ResetDuringCheckpointStore(getStateDatabase(dbPath));
    try {
      let requestNumber = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: {
          resolve: () => ({
            model: "test-model",
            baseUrl: "https://provider.test/v1",
            apiKey: "test-api-key",
            provider: "test",
          }),
        },
        transcriptId,
        transcriptStore: store,
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: "exec-1",
                      function: {
                        name: "exec_command",
                        arguments: JSON.stringify({ cmd: "echo", args: ["safe"] }),
                      },
                    }],
                  },
                }],
              }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })]);
        },
      });
      store.onRunningCheckpoint = () => adapter.reset({ clearPersistedState: true });
      const events: Array<{ type: string; message?: string }> = [];
      adapter.onEvent((event) => {
        const raw = event.raw as { type?: string; error?: { message?: string } };
        events.push({ type: String(raw.type ?? ""), message: raw.error?.message });
      });

      await assert.rejects(adapter.send("run a tool"), /superseded by a destructive session reset/);
      assert.deepEqual(store.listTurns(transcriptId), []);
      assert.equal(events.some((event) => event.type === "turn.failed"), true);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("clears durable Native context only for an explicit destructive reset", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-clear-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-clear-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-clear";
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const resolver: NativeModelResolver = {
      resolve: () => ({
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "test-api-key",
        provider: "test",
      }),
    };

    try {
      const firstAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        fetchImpl: async () => sse([
          JSON.stringify({ choices: [{ delta: { content: "remembered" }, finish_reason: "stop" }] }),
        ]),
      });
      await firstAdapter.send("remember this");
      firstAdapter.reset({ clearPersistedState: true });

      let restoredMessages: Array<{ role: string }> = [];
      const restoredAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string }> };
          restoredMessages = body.messages ?? [];
          return sse([JSON.stringify({ choices: [{ delta: { content: "fresh" }, finish_reason: "stop" }] })]);
        },
      });
      await restoredAdapter.send("new context");
      assert.deepEqual(restoredMessages.map((message) => message.role), ["user"]);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("emits a sanitized turn failure when the initial checkpoint fails", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-checkpoint-failure-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-checkpoint-state-"));
    const dbPath = path.join(stateDir, "state.db");

    class FailingTranscriptStore extends NativeTranscriptStore {
      override beginTurn(): void {
        throw new Error("secret-api-key environment-secret checkpoint unavailable");
      }
    }

    const store = new FailingTranscriptStore(getStateDatabase(dbPath));
    const resolver: NativeModelResolver = {
      resolve: () => ({
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "secret-api-key",
        provider: "test",
      }),
    };

    try {
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId: "native-transcript-checkpoint-failure",
        transcriptStore: store,
        env: { NATIVE_TEST_SECRET: "environment-secret" },
        turnTimeoutMs: 5,
        fetchImpl: async () => {
          throw new Error("fetch should not run after checkpoint failure");
        },
      });
      const events: Array<{ type: string; message?: string }> = [];
      adapter.onEvent((event) => {
        const raw = event.raw as { type?: string; error?: { message?: string } };
        events.push({ type: String(raw.type ?? ""), message: raw.error?.message });
      });

      await assert.rejects(adapter.send("hello"), /AggregateError/);
      const failure = events.find((event) => event.type === "turn.failed");
      assert.ok(failure?.message);
      assert.doesNotMatch(failure.message, /secret-api-key|environment-secret/);
      assert.match(failure.message, /\[redacted\]/);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not restore failed or cancelled turns as successful context", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-failure-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-failure-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const transcriptId = "native-transcript-failure";
    const resolver: NativeModelResolver = {
      resolve: () => ({
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "test-api-key",
        provider: "test",
      }),
    };

    try {
      let requestNumber = 0;
      const failedAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        fetchImpl: async () => {
          requestNumber += 1;
          if (requestNumber === 1) {
            return sse([
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "exec-1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "echo", args: ["safe"] }) } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          throw new Error("provider failed");
        },
      });

      await assert.rejects(failedAdapter.send("failed turn"));
      assert.equal(store.listTurns(transcriptId)[0]?.status, "failed");

      const controller = new AbortController();
      const cancelledAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId: `${transcriptId}-cancelled`,
        transcriptStore: store,
        fetchImpl: async () => {
          setTimeout(() => controller.abort(), 50);
          return sse([
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "exec-2", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 120_000 }) } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]);
        },
      });
      await assert.rejects(
        cancelledAdapter.send("cancelled turn", { signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(store.listTurns(`${transcriptId}-cancelled`)[0]?.status, "cancelled");

      let restoredMessages: Array<{ role: string }> = [];
      const restoredAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string }> };
          restoredMessages = body.messages ?? [];
          return sse([JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] })]);
        },
      });
      await restoredAdapter.send("recover");
      assert.deepEqual(restoredMessages.map((message) => message.role), ["user"]);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

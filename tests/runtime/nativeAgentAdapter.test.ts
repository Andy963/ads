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
  for (const source of ["option", "environment"] as const) {
    for (const configured of [1_800_000, 3_600_000]) {
      it(`keeps the 30-minute turn deadline and clamps larger values (${source}: ${configured})`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-turn-deadline-"));
        const entered = Promise.withResolvers<AbortSignal>();
        try {
          const adapter = new NativeAgentAdapter({
            credentialOwner: "test-owner", workspaceRoot: workspace,
            ...(source === "option" ? { turnTimeoutMs: configured } : {}),
            env: { ADS_NATIVE_RUNTIME_TURN_TIMEOUT_MS: String(source === "environment" ? configured : 1) },
            modelResolver: { resolve: () => ({
              model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
            }) },
            fetchImpl: async (_input, init) => {
              assert.ok(init?.signal);
              const signal = init.signal;
              entered.resolve(signal);
              return new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          });
          const failed = assert.rejects(adapter.send("Wait for the configured deadline"));
          const signal = await entered.promise;
          t.mock.timers.tick(600_000);
          assert.equal(signal.aborted, false, "The old 10-minute ceiling must not abort the turn");
          t.mock.timers.tick(1_199_999);
          assert.equal(signal.aborted, false);
          t.mock.timers.tick(1);
          assert.equal(signal.aborted, true);
          assert.match(String(signal.reason), /timed out/);
          await failed;
        } finally {
          fs.rmSync(workspace, { recursive: true, force: true });
        }
      });
    }
  }

  it("serializes overlapping user sends after the preceding assistant response", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-overlapping-turns-"));
    let releaseReply!: () => void;
    const replyReady = new Promise<void>(resolve => { releaseReply = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const requests: NativeChatMessage[][] = [];
    try {
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace,
        modelResolver: { resolve: () => ({
          model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
        }) },
        fetchImpl: async (_input, init) => {
          requests.push((JSON.parse(String(init?.body)) as { messages: NativeChatMessage[] }).messages);
          if (requests.length === 1) {
            markStarted();
            await replyReady;
          }
          return sse([JSON.stringify({ choices: [{
            delta: { content: "Reply", tool_calls: null }, finish_reason: "stop",
          }] })]);
        },
      });
      const first = adapter.send("First request");
      await started;
      const second = adapter.send("Second request");
      await Promise.resolve();
      assert.equal(requests.length, 1);
      releaseReply();
      await Promise.all([first, second]);
      assert.deepEqual(requests.map(messages => messages.map(message => message.role)), [
        ["user"], ["user", "assistant", "user"],
      ]);
      assert.equal(requests[1]?.[0]?.content, "First request");
      assert.equal(requests[1]?.[2]?.content, "Second request");
    } finally {
      releaseReply();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps request turns paired across nullable deltas, failed turns, and durable restore", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-nullable-turns-"));
    const dbPath = path.join(workspace, "state.db");
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello", "utf8");
      const store = new NativeTranscriptStore(getStateDatabase(dbPath));
      const requests: NativeChatMessage[][] = [];
      let failNext = false;
      let callNumber = 0;
      const createAdapter = () => new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        transcriptId: "nullable-turns",
        transcriptStore: store,
        modelResolver: { resolve: () => ({
          model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
        }) },
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { messages: NativeChatMessage[] };
          requests.push(body.messages);
          if (failNext) {
            failNext = false;
            return sse([JSON.stringify({ choices: [{ delta: { tool_calls: {} } }] })]);
          }
          if (body.messages.at(-1)?.role === "user") {
            return sse([
              JSON.stringify({ choices: [{ delta: { role: "assistant", tool_calls: null } }] }),
              JSON.stringify({ choices: [{ delta: { tool_calls: [{
                index: 0, type: "function", id: `read-${++callNumber}`,
                function: { name: "read_file", arguments: '{"file":"hello.txt"}' },
              }] } }] }),
              JSON.stringify({ choices: [{ delta: { tool_calls: null }, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([JSON.stringify({ choices: [{
            delta: { content: "Done", tool_calls: null, function_call: null }, finish_reason: "stop",
          }] })]);
        },
      });
      const first = createAdapter();
      first.setDeveloperInstructions("Test instructions");
      await first.send("First request");
      failNext = true;
      await assert.rejects(first.send("Retry this request"), /malformed SSE tool calls/);
      await first.send("Retry this request");
      const restored = createAdapter();
      restored.setDeveloperInstructions("Test instructions");
      await restored.send("After restore");

      const roles = requests.map(messages => messages.map(message => message.role));
      const completed = ["user", "assistant", "tool", "assistant"];
      const failed = ["user", "assistant"];
      assert.deepEqual(roles, [
        ["system", "user"],
        ["system", "user", "assistant", "tool"],
        ["system", ...completed, "user"],
        ["system", ...completed, ...failed, "user"],
        ["system", ...completed, ...failed, "user", "assistant", "tool"],
        ["system", ...completed, ...failed, ...completed, "user"],
        ["system", ...completed, ...failed, ...completed, "user", "assistant", "tool"],
      ]);
      for (const messages of requests) {
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index]!;
          if (message.role === "tool") {
            assert.equal(message.tool_call_id, messages[index - 1]?.tool_calls?.[0]?.id);
          }
        }
      }
      assert.deepEqual(store.listTurns("nullable-turns").map(turn => turn.status), ["completed", "failed", "completed", "completed"]);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

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
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "read-1", function: { name: "read_file", arguments: '{"file":"hello.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "The file says hello." }, finish_reason: "stop" }] }),
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
                choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: call.id, function: { name: call.name, arguments: call.arguments } }] } }],
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
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "read-1", function: { name: "read_file", arguments: '{"file":"hello.txt"}' } }] } }] }),
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
                      type: "function",
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
              JSON.stringify({ choices: [{ delta: { content: "First round", tool_calls: [{ index: 0, type: "function", id: "read-1", function: { name: "read_file", arguments: '{"file":"hello.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Second round" }, finish_reason: "stop" }] }),
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
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "missing-1", function: { name: "read_file", arguments: '{"file":"missing.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Recovered after the tool error." }, finish_reason: "stop" }] }),
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

  it("allows more than the default budget only when unlimited rounds are explicit", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-unlimited-"));
    try {
      fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n", "utf8");
      const toolRounds = 70;
      let requestNumber = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        env: {
          ADS_AGENT_MAX_TOOL_ROUNDS: "0",
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
                      type: "function",
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

  for (const configured of [undefined, "", "  ", "invalid", "-1", "1.5"]) {
    it(`caps tool rounds at 128 plus one final response for an unset or invalid budget (${JSON.stringify(configured)})`, async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-default-limit-"));
      try {
        fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n", "utf8");
        let requestNumber = 0;
        const adapter = new NativeAgentAdapter({
          credentialOwner: "test-owner", workspaceRoot: workspace,
          env: { ADS_AGENT_MAX_TOOL_ROUNDS: configured, ADS_NATIVE_RUNTIME_MAX_TOOL_ROUNDS: undefined },
          modelResolver: { resolve: () => ({
            model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
          }) },
          fetchImpl: async (_input, init) => {
            const body = JSON.parse(String(init?.body));
            requestNumber += 1;
            // Bound the fixture itself so a regression to unlimited cannot hang.
            if (requestNumber > 128) {
              assert.equal(body.tool_choice, "none");
              assert.equal(body.tools, undefined);
              return sse([JSON.stringify({ choices: [{ delta: { content: "Final budget summary" }, finish_reason: "stop" }] })]);
            }
            assert.ok(body.tools.length > 0);
            return sse([JSON.stringify({ choices: [{
              delta: { tool_calls: [{ index: 0, type: "function", id: `read-${requestNumber}`,
                function: { name: "read_file", arguments: '{"file":"hello.txt"}' },
              }] }, finish_reason: "tool_calls",
            }] })]);
          },
        });
        const result = await adapter.send("Keep inspecting the file");
        assert.equal(requestNumber, 129);
        assert.equal(result.response, "Final budget summary");
        if (configured === undefined) {
          requestNumber = 0;
          const next = await adapter.send("Continue inspecting");
          assert.equal(requestNumber, 129, "Each user turn must receive a fresh budget");
          assert.equal(next.response, "Final budget summary");
        }
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }

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
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "env-limit-1", function: { name: "read_file", arguments: '{"file":"missing.txt"}' } }] } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
            ]);
          },
        });

        const result = await adapter.send("Inspect the missing file");

        assert.match(result.response, /tool-round limit/);
        assert.equal(requestNumber, 2);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("summarizes the last tool result at the limit and preserves balanced durable continuation", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-adapter-limit-"));
    try {
      let requestNumber = 0;
      const requests: NativeChatMessage[][] = [];
      const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
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
        maxToolRounds: 1,
        transcriptId: "tool-limit",
        transcriptStore: store,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { messages: NativeChatMessage[]; tool_choice: string; tools?: unknown[] };
          requests.push(body.messages);
          requestNumber += 1;
          if (requestNumber === 2) {
            assert.equal(body.tool_choice, "none");
            assert.equal(body.tools, undefined);
            assert.equal(body.messages.at(-1)?.role, "tool");
            assert.deepEqual(body.messages.map(message => message.role), ["system", "user", "assistant", "tool"]);
            assert.match(String(body.messages[0]?.content), /budget.*exhausted/);
            return sse([JSON.stringify({ choices: [{ delta: { content: "The file is missing; further inspection requires another prompt." }, finish_reason: "stop" }],
              usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
            })]);
          }
          if (requestNumber > 1) {
            return sse([JSON.stringify({ choices: [{ delta: { content: "Continued" }, finish_reason: "stop" }] })]);
          }
          return sse([
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "limit-1", function: { name: "read_file", arguments: '{"file":"missing.txt"}' } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]);
        },
      });
      const rawEvents: string[] = [];
      adapter.onEvent((event) => rawEvents.push(event.raw.type));

      const result = await adapter.send("Inspect the missing file");

      assert.equal(result.response, "The file is missing; further inspection requires another prompt.");
      assert.equal(requestNumber, 2);
      assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
      assert.equal(rawEvents.includes("turn.completed"), true);
      assert.equal(rawEvents.includes("turn.failed"), false);
      const cappedTurn = store.listTurns("tool-limit")[0]!;
      assert.deepEqual(cappedTurn.messages.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
      assert.equal(cappedTurn.messages.at(-1)?.content, result.response);
      assert.deepEqual(cappedTurn.entries.at(-1), { kind: "message", message: cappedTurn.messages.at(-1) });

      await adapter.send("Continue now");
      assert.deepEqual(requests[2]?.map(message => message.role), ["user", "assistant", "tool", "assistant", "user"]);
      const restored = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace, modelResolver: resolver,
        transcriptId: "tool-limit", transcriptStore: store,
        fetchImpl: async (_input, init) => {
          requests.push((JSON.parse(String(init?.body)) as { messages: NativeChatMessage[] }).messages);
          return sse([JSON.stringify({ choices: [{ delta: { content: "Restored" }, finish_reason: "stop" }] })]);
        },
      });
      await restored.send("Continue after restore");
      assert.deepEqual(requests[3]?.map(message => message.role), ["user", "assistant", "tool", "assistant", "user", "assistant", "user"]);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("sends reasoning_effort for models that do not declare the capability", async () => {
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

  it("includes the session reasoning_effort for every model", async () => {
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
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "exec-1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 120_000 }) } }] } }] }),
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
        env: { SHORT_SECRET: "q", SHORT_SECRET_SLASH: "/", GIT_AUTHOR_NAME: "Andy" },
        fetchImpl: async () => sse([
          JSON.stringify({
            choices: [{
              delta: { content: "SHORT_SECRET=q\nSHORT_SECRET_SLASH=/\nPATH_SEPARATOR=/\nauthor=Andy" },
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
      assert.doesNotMatch(raw, /SHORT_SECRET_SLASH=\//);
      assert.match(raw, /PATH_SEPARATOR=\//);
      assert.match(raw, /author=Andy/);
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
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "exec-1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "process.stdout.write(process.env.ADS_WEB_SESSION_PEPPER ?? '')"] }) } }] } }] }),
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
                      type: "function",
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
                      type: "function",
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
      assert.equal(events.some((event) => event.type === "turn.failed"), false);
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

  it("restores failed task evidence without treating it as a successful turn", async () => {
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
              JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "exec-1", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "echo", args: ["safe"] }) } }] } }] }),
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
            JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "exec-2", function: { name: "exec_command", arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeout_ms: 120_000 }) } }] } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          ]);
        },
      });
      await assert.rejects(
        cancelledAdapter.send("cancelled turn", { signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(store.listTurns(`${transcriptId}-cancelled`)[0]?.status, "cancelled");

      let restoredMessages: NativeChatMessage[] = [];
      const restoredAdapter = new NativeAgentAdapter({
        credentialOwner: "test-owner",
        workspaceRoot: workspace,
        workingDirectory: workspace,
        modelResolver: resolver,
        transcriptId,
        transcriptStore: store,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: NativeChatMessage[] };
          restoredMessages = body.messages ?? [];
          return sse([JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] })]);
        },
      });
      await restoredAdapter.send("recover");
      assert.deepEqual(restoredMessages.map((message) => message.role), ["user", "assistant", "tool", "assistant", "user"]);
      assert.equal(restoredMessages[0]?.content, "failed turn");
      assert.match(String(restoredMessages.at(-2)?.content), /turn was failed, not completed/);
      assert.equal(store.listTurns(transcriptId)[0]?.status, "failed");
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("projects compacted Native context without changing the durable transcript", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-context-projection-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-context-projection-state-"));
    const dbPath = path.join(stateDir, "state.db");
    const transcriptId = "native-transcript-context-projection";
    const store = new NativeTranscriptStore(getStateDatabase(dbPath));
    const requests: NativeChatMessage[][] = [];
    const contextEvents: Array<{ text?: string }> = [];

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
            contextWindow: 1_000,
          }),
        },
        transcriptId,
        transcriptStore: store,
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: NativeChatMessage[] };
          requests.push(body.messages ?? []);
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
          ]);
        },
      });
      adapter.onEvent((event) => {
        const item = (event.raw as { item?: { type?: string; text?: string } }).item;
        if (item?.type === "context") contextEvents.push({ text: item.text });
      });

      await adapter.send("a".repeat(300));
      await adapter.send("b".repeat(300));
      await adapter.send("c".repeat(300));

      assert.equal(requests.length, 3);
      assert.equal(requests[2]?.at(-1)?.role, "user");
      assert.equal(requests[2]?.at(-1)?.content, "c".repeat(300));
      assert.equal(requests[2]?.some((message) => message.content === "a".repeat(300)), false);
      assert.equal(contextEvents.length > 0, true);
      assert.match(String(contextEvents.at(-1)?.text), /compacted older turns/i);

      const restored = store.loadCompletedMessages(transcriptId, "restored");
      assert.equal(restored.some((message) => message.content === "a".repeat(300)), true);
      assert.equal(restored.some((message) => message.content === "b".repeat(300)), true);
      assert.equal(restored.some((message) => message.content === "c".repeat(300)), true);
    } finally {
      resetStateDatabaseForTests();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

import "../helpers/adsStateDir.js";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { projectNativeContinuation, projectNativeContinuationTurn } from "../../server/runtime/nativeContinuation.js";
import { projectNativeContext } from "../../server/runtime/nativeContextProjection.js";
import type { NativeChatMessage, NativeChatToolCall } from "../../server/runtime/openAiCompatibleClient.js";
import { getStateDatabase, closeAllStateDatabases } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";

const task = "Inspect the workspace and explain the remaining work.";
const nextPrompt = "Continue.";
const model = { model: "test-model", provider: "test", baseUrl: "https://provider.test/v1", apiKey: "test-key" };

function reply(content = "Done", calls: NativeChatToolCall[] = []): Response {
  const delta = { content, tool_calls: calls.map((call, index) => ({ index, ...call })) };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function fixture(t: TestContext) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-continuation-"));
  const db = getStateDatabase(path.join(workspace, "state.db"));
  const store = new NativeTranscriptStore(db);
  t.after(() => {
    closeAllStateDatabases();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { workspace, db, store };
}

function assertTaskContext(messages: NativeChatMessage[]): void {
  assert.equal(messages.filter(message => message.role === "user" && message.content === task).length, 1);
  assert.equal(messages.at(-1)?.content, nextPrompt);
  assert.match(String(messages.find(message => message.role === "assistant" && String(message.content).startsWith("[Native runtime:"))?.content), /not completed/);
  assert.doesNotThrow(() => projectNativeContext(messages));
}

describe("native stopped-turn continuation", () => {
  for (const restored of [false, true]) {
    for (const stage of ["before-text", "after-tool", "partial-batch", "active-tool", "provider-failure"] as const) {
      it(`retains task and confirmed outcomes at ${stage}, restored=${restored}`, async t => {
        const { workspace, store } = fixture(t);
        fs.writeFileSync(path.join(workspace, "note.txt"), "confirmed file result");
        const controller = new AbortController();
        const requests: NativeChatMessage[][] = [];
        let continuing = false;
        let requestCount = 0;
        let toolsStarted = 0;
        const effectsPath = path.join(workspace, "effects.txt");
        const cancellation = stage === "active-tool" ? setInterval(() => {
          if (fs.existsSync(effectsPath)) controller.abort();
        }, 10) : undefined;
        t.after(() => { if (cancellation) clearInterval(cancellation); });
        const create = () => new NativeAgentAdapter({
          credentialOwner: "test-owner", workspaceRoot: workspace, workingDirectory: workspace,
          transcriptId: "continuation", transcriptStore: store,
          turnTimeoutMs: 5_000,
          modelResolver: { resolve: () => model },
          fetchImpl: async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)).messages);
            requestCount += 1;
            if (continuing) return reply();
            if (stage === "provider-failure") return new Response("Invalid request", { status: 400 });
            if (stage === "before-text" || requestCount > 1) {
              controller.abort();
              throw Object.assign(new Error("Stopped"), { name: "AbortError" });
            }
            const calls: NativeChatToolCall[] = stage === "after-tool"
              ? [{ id: "read", type: "function", function: { name: "read_file", arguments: '{"file":"note.txt"}' } }]
              : [1, 2].map(index => ({
                id: `exec-${index}`, type: "function", function: {
                  name: "exec_command",
                  arguments: JSON.stringify({ cmd: process.execPath, args: ["-e", `require('node:fs').appendFileSync('effects.txt', '${index}'); ${stage === "active-tool" ? "setInterval(() => {}, 1000)" : `console.log('confirmed result ${index}')`}`] }),
                },
              }));
            return reply("Inspecting the workspace.", calls);
          },
        });
        const first = create();
        first.onEvent(event => {
          const raw = event.raw;
          if (raw.type === "item.started" && raw.item.type === "command_execution") {
            toolsStarted += 1;
          }
          if (stage === "partial-batch" && raw.type === "item.completed" && raw.item.type === "command_execution") controller.abort();
        });
        await assert.rejects(first.send(task, { signal: controller.signal }));
        const before = store.listTurns("continuation");
        assert.equal(before[0]?.status, stage === "provider-failure" ? "failed" : "cancelled");
        assert.equal(before[0]?.messages[0]?.content, task);
        const confirmed = stage === "after-tool" || stage === "partial-batch" ? 1 : 0;
        assert.equal(before[0]?.messages.filter(message => message.role === "tool").length, confirmed);

        continuing = true;
        const second = restored ? create() : first;
        if (restored) assert.equal(second.hasRestoredTranscript(), true);
        await second.send(nextPrompt);
        const context = requests.at(-1)!;
        assertTaskContext(context);
        for (const message of before[0]!.messages.filter(message => message.role === "tool")) {
          assert.deepEqual(context.find(candidate => candidate.tool_call_id === message.tool_call_id), message);
        }
        const unknown = context.filter(message => message.role === "tool" && String(message.content).includes('"status":"unknown"'));
        assert.equal(unknown.length, stage === "partial-batch" ? 1 : stage === "active-tool" ? 2 : 0);
        for (const message of unknown) assert.match(String(message.content), /side effects.*do not assume success/);
        assert.equal(toolsStarted, stage === "partial-batch" || stage === "active-tool" ? 1 : 0);
        assert.equal(fs.existsSync(effectsPath), stage === "partial-batch" || stage === "active-tool");
        if (fs.existsSync(effectsPath)) assert.equal(fs.readFileSync(effectsPath, "utf8"), "1");
        assert.deepEqual(store.listTurns("continuation")[0], before[0], "Request projection must not rewrite terminal evidence");
      });
    }
  }

  it("projects an interrupted process checkpoint and preserves writer fencing", async t => {
    const { workspace, store, db } = fixture(t);
    store.claimTranscript("crashed", "old-writer");
    store.beginTurn({ transcriptId: "crashed", turnId: "old-turn", writerId: "old-writer",
      messages: [{ role: "user", content: task }], entries: [], provider: {} });
    assert.equal(store.hasContinuationMessages("crashed"), true);
    assert.equal((db.prepare("SELECT status FROM native_transcript_turns").get() as { status: string }).status, "running");
    let context: NativeChatMessage[] = [];
    const adapter = new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace,
      transcriptId: "crashed", transcriptStore: store, modelResolver: { resolve: () => model },
      fetchImpl: async (_url, init) => { context = JSON.parse(String(init?.body)).messages; return reply(); },
    });
    assert.equal(adapter.hasRestoredTranscript(), true);
    await adapter.send(nextPrompt);
    assertTaskContext(context);
    assert.equal(store.listTurns("crashed")[0]?.status, "interrupted");
    assert.throws(() => store.updateTurn({ transcriptId: "crashed", turnId: "old-turn", writerId: "old-writer",
      status: "completed", messages: [], entries: [], usage: null }), /superseded/);
  });

  it("retains one task across retry cancellation without retaining each attempt", async t => {
    const { workspace, store } = fixture(t);
    const controller = new AbortController();
    const requests: NativeChatMessage[][] = [];
    let continuing = false;
    let retries = 0;
    const adapter = new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace,
      transcriptId: "retry", transcriptStore: store, retryBackoffMs: [0, 0],
      modelResolver: { resolve: () => model },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)).messages);
        return continuing ? reply() : new Response("Temporary", { status: 503 });
      },
    });
    adapter.onEvent(event => { if (event.retry && ++retries === 2) controller.abort(); });
    await assert.rejects(adapter.send(task, { signal: controller.signal }));
    continuing = true;
    await adapter.send(nextPrompt);
    assertTaskContext(requests.at(-1)!);
    assert.equal(store.listTurns("retry").length, 2);
  });

  for (const mode of ["ephemeral", "durable", "restored"] as const) {
    it(`retains interrupted image references in ${mode} context and honors reset`, async t => {
      const { workspace, store } = fixture(t);
      const source = path.join(workspace, "image.png");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNAAAAABJRU5ErkJggg==", "base64");
      fs.writeFileSync(source, png);
      const controller = new AbortController();
      const requests: NativeChatMessage[][] = [];
      let continuing = false;
      const create = () => new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace,
        ...(mode === "ephemeral" ? {} : { transcriptId: "image", transcriptStore: store }),
        modelResolver: { resolve: () => model },
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)).messages);
          if (continuing) return reply();
          controller.abort();
          throw Object.assign(new Error("Stopped"), { name: "AbortError" });
        },
      });
      const first = create();
      await assert.rejects(first.send([{ type: "text", text: task }, { type: "local_image", path: source }], { signal: controller.signal }));
      fs.unlinkSync(source);
      continuing = true;
      const next = mode === "restored" ? create() : first;
      await next.send(nextPrompt);
      assert.deepEqual(requests.at(-1)?.[0]?.content, requests[0]?.[0]?.content);
      assert.match(JSON.stringify(requests.at(-1)?.[0]?.content), /data:image\/png;base64/);
      next.reset({ clearPersistedState: true });
      await next.send("New task");
      assert.deepEqual(requests.at(-1), [{ role: "user", content: "New task" }]);
      if (mode !== "ephemeral") assert.equal(store.listTurns("image").length, 1);
    });
  }

  it("keeps stopped tasks with Continue under token pressure without mutating evidence", () => {
    const turns = [{ status: "cancelled" as const, messages: [
      { role: "user" as const, content: task },
      { role: "assistant" as const, content: null, tool_calls: [{ id: "read", type: "function" as const, function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool" as const, content: "x".repeat(20_000), tool_call_id: "read" },
    ] }];
    const original = structuredClone(turns);
    const context = projectNativeContinuation(turns);
    const projection = projectNativeContext([...context.messages, { role: "user", content: nextPrompt }], {
      contextWindow: 512, reservedTokens: 64, requiredRecentTurns: context.pendingTurns + 1,
    });
    assertTaskContext(projection.messages);
    assert.equal(projection.diagnostic.truncatedToolOutputs, 1);
    assert.deepEqual(turns, original);
    assert.deepEqual(projectNativeContinuationTurn({ status: "running", messages: turns[0].messages }), []);
  });
});

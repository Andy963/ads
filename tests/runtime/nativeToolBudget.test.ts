import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { NativeChatMessage, NativeChatToolCall } from "../../server/runtime/openAiCompatibleClient.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";

type RequestBody = { messages: NativeChatMessage[]; tools?: unknown[]; tool_choice: string; parallel_tool_calls?: boolean };

function reply(text: string, calls: NativeChatToolCall[] = [], streaming = true): Response {
  const message = { content: text, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) };
  const finish_reason = calls.length ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  return streaming
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason }], usage })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    : Response.json({ choices: [{ message, finish_reason }], usage });
}

function harness(t: TestContext, finalReply: (body: RequestBody) => Response, streaming = true) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-tool-budget-"));
  t.after(() => {
    resetStateDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(workspace, "evidence.txt"), "saved tool evidence", "utf8");
  const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
  const requests: RequestBody[] = [];
  const events: string[] = [];
  const adapter = new NativeAgentAdapter({
    credentialOwner: "test-owner", workspaceRoot: workspace, maxToolRounds: 1,
    transcriptId: "budget", transcriptStore: store, retryBackoffMs: [0],
    modelResolver: { resolve: () => ({
      model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
    }) },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as RequestBody;
      requests.push(body);
      if (requests.length > 3) throw new Error("Fixture request budget exceeded");
      if (body.tool_choice === "none") return finalReply(body);
      return reply("Inspecting evidence.", [0, 1].map(index => ({
        id: `read-${requests.length}-${index}`, type: "function", function: {
          name: "read_file", arguments: '{"file":"evidence.txt"}',
        },
      })), streaming);
    },
  });
  adapter.onEvent(event => events.push(JSON.stringify(event.raw)));
  return { adapter, store, requests, events, workspace };
}

describe("Native tool budget finalization", () => {
  for (const streaming of [true, false]) {
    it(`counts a multi-tool response once and summarizes without tools (streaming=${streaming})`, async t => {
      const { adapter, store, requests } = harness(t, () => reply("Evidence summary.", [], streaming), streaming);
      const result = await adapter.send("Inspect evidence", { streaming });
      assert.equal(result.response, "Inspecting evidence.\n\nEvidence summary.");
      assert.equal(requests.length, 2);
      assert.ok(requests[0]!.tools!.length > 0);
      assert.equal(requests[1]!.tools, undefined);
      assert.equal(requests[1]!.tool_choice, "none");
      assert.equal(requests[1]!.parallel_tool_calls, undefined);
      assert.deepEqual(requests[1]!.messages.map(message => message.role), ["system", "user", "assistant", "tool", "tool"]);
      assert.ok(requests[1]!.messages.filter(message => message.role === "tool").every(message => String(message.content).includes("saved tool evidence")));
      assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
      const turn = store.listTurns("budget")[0]!;
      assert.equal(turn.status, "completed");
      assert.deepEqual(turn.messages.map(message => message.role), ["user", "assistant", "tool", "tool", "assistant"]);
      assert.equal(turn.messages.at(-1)?.content, "Evidence summary.");
    });
  }

  for (const failure of ["tools", "empty", "http", "malformed", "partial"] as const) {
    it(`preserves results without retrying or executing tools when finalization returns ${failure}`, async t => {
      const { adapter, store, requests, events, workspace } = harness(t, () => {
        if (failure === "http") return new Response("Unavailable", { status: 503 });
        if (failure === "malformed") return new Response("data: invalid-json\n\n", { headers: { "content-type": "text/event-stream" } });
        if (failure === "partial") return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Unverified partial summary" } }] })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
        if (failure === "empty") return reply("   ");
        return reply("Unverified partial summary", [{
          id: "forbidden", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({
            patch: "*** Begin Patch\n*** Add File: forbidden.txt\n+must not execute\n*** End Patch",
          }) },
        }]);
      });
      const result = await adapter.send("Inspect evidence");
      assert.equal(requests.length, 2);
      assert.match(result.response, /tool-round limit/);
      assert.ok(!result.response.includes("Unverified partial summary"));
      assert.ok(!events.join("\n").includes("Unverified partial summary"));
      assert.ok(!events.join("\n").includes('"type":"turn.failed"'));
      assert.equal(fs.existsSync(path.join(workspace, "forbidden.txt")), false);
      const turn = store.listTurns("budget")[0]!;
      assert.equal(turn.status, "completed");
      assert.deepEqual(turn.messages.map(message => message.role), ["user", "assistant", "tool", "tool", "assistant"]);
      assert.match(String(turn.messages.at(-1)?.content), /tool-round limit/);
      assert.ok(!JSON.stringify(turn).includes("forbidden"));
    });
  }

  it("does not turn cancellation during the summary into a completed turn", async t => {
    const controller = new AbortController();
    const { adapter, store, requests, events } = harness(t, () => {
      controller.abort();
      return reply("Cancelled summary");
    });
    await assert.rejects(adapter.send("Inspect evidence", { signal: controller.signal }), /abort/i);
    assert.equal(requests.length, 2);
    assert.equal(store.listTurns("budget")[0]?.status, "cancelled");
    assert.ok(!events.join("\n").includes('"type":"turn.completed"'));
    assert.ok(!events.join("\n").includes("Cancelled summary"));
  });

  it("does not restore cleared history when reset interrupts the summary", async t => {
    const { adapter, store, requests, events } = harness(t, () => {
      adapter.reset({ clearPersistedState: true });
      return reply("Stale summary");
    });
    await assert.rejects(adapter.send("Inspect evidence"), /superseded|reset/i);
    assert.equal(requests.length, 2);
    assert.equal(store.listTurns("budget").length, 0);
    assert.ok(!events.join("\n").includes("Stale summary"));
    assert.ok(!events.join("\n").includes('"type":"turn.completed"'));
  });
});

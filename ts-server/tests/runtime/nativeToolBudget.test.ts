import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { ToolLoopPausedError } from "../../server/runtime/toolLoopGuard.js";
import { NativeContextLimitError } from "../../server/runtime/nativeContextProjection.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";
import type { NativeChatMessage } from "../../server/runtime/openAiCompatibleClient.js";

function fixture(t: TestContext) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-progress-"));
  t.after(() => { resetStateDatabaseForTests(); fs.rmSync(workspace, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(workspace, "evidence.txt"), Array.from({ length: 1000 }, (_, i) => `evidence-${i}`).join("\n"));
  const db = getStateDatabase(path.join(workspace, "state.db"));
  return { workspace, db, store: new NativeTranscriptStore(db) };
}
function reply(text: string, line?: number, id = "read"): Response {
  return Response.json({ choices: [{ message: line === undefined ? { content: text } : { content: text,
    tool_calls: [{ type: "function", id, function: { name: "read_file", arguments: JSON.stringify({ file: "evidence.txt", start_line: line, line_count: 1 }) } }] },
    finish_reason: line === undefined ? "stop" : "tool_calls" }] });
}
const model = { model: "model", baseUrl: "https://provider.test/v1", apiKey: "fixture-key", provider: "fixture", contextWindow: 12_288 };

describe("Native progress-based execution", () => {
  it("completes 1000 productive calls with bounded context, append-only evidence, and durable restore", async t => {
    const { workspace, store, db } = fixture(t);
    let rounds = 0;
    let summaries = 0;
    let maxMessages = 0;
    const adapter = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      maxToolRounds: 1, env: { ADS_AGENT_MAX_TOOL_ROUNDS: "64" }, transcriptId: "long", transcriptStore: store,
      modelResolver: { resolve: () => model }, fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        maxMessages = Math.max(maxMessages, body.messages.length);
        if (body.tool_choice === "none") {
          summaries++;
          assert.match(JSON.stringify(body.messages), /Inspect all evidence/);
          return reply(`Read evidence through line ${rounds}. Continue at the next line.`);
        }
        if (++rounds <= 1000) return reply("", rounds, `read-${rounds}`);
        return reply("Done");
      },
    });
    assert.equal((await adapter.send("Inspect all evidence", { streaming: false })).response, "Done");
    assert.equal(rounds, 1001);
    assert.ok(summaries > 10);
    assert.ok(maxMessages < 135);
    const history = store.listTurns("long");
    assert.equal(history[0]?.status, "completed");
    assert.equal(history[0]?.messages.filter(message => message.role === "tool").length, 1000);
    const row = db.prepare("SELECT messages_json FROM native_transcript_turns").get() as { messages_json: string };
    assert.ok(JSON.parse(row.messages_json).length < 10);
    assert.ok((db.prepare("SELECT COUNT(*) AS count FROM native_transcript_chunks").get() as { count: number }).count > 1000);
    assert.match(store.readHistory("long"), /Inspect all evidence/);
    assert.equal(store.readHistory("other"), '{"done":true}');
    let restored: NativeChatMessage[] = [];
    const next = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      transcriptId: "long", transcriptStore: store, modelResolver: { resolve: () => model },
      fetchImpl: async (_url, init) => { restored = JSON.parse(String(init?.body)).messages; return reply("Restored"); },
    });
    await next.send("Continue without replay", { streaming: false });
    assert.ok(restored.length < 135);
    assert.match(JSON.stringify(restored), /Inspect all evidence/);
  });

  it("can compact with a streaming-only provider without exposing summary deltas", async t => {
    const { workspace, store } = fixture(t);
    let calls = 0;
    let summaries = 0;
    const events: string[] = [];
    const adapter = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      transcriptId: "stream-only", transcriptStore: store,
      modelResolver: { resolve: () => ({ ...model, capabilities: { nonStreaming: "unsupported" } }) },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.stream, true);
        let response: Response;
        if (body.tool_choice === "none") { summaries++; response = reply("Private compaction summary."); }
        else response = ++calls <= 68 ? reply("", calls, `read-${calls}`) : reply("Done");
        const payload = await response.json();
        const choice = payload.choices[0];
        const delta = { ...choice.message, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call: object, index: number) => ({ ...call, index })) } : {}) };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: choice.finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    adapter.onEvent(event => events.push(JSON.stringify(event.raw)));
    assert.equal((await adapter.send("Read all lines")).response, "Done");
    assert.ok(summaries > 0);
    assert.doesNotMatch(events.join("\n"), /Private compaction summary/);
  });

  it("warns, pauses an unchanged read loop, and restores evidence without replay", async t => {
    const { workspace, store } = fixture(t);
    let calls = 0;
    const events: string[] = [];
    const create = () => new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      transcriptId: "loop", transcriptStore: store, modelResolver: { resolve: () => model },
      fetchImpl: async () => { calls++; return reply("", 1, `read-${calls}`); },
    });
    const first = create();
    first.onEvent(event => events.push(JSON.stringify(event.raw)));
    await assert.rejects(first.send("Read", { streaming: false }), ToolLoopPausedError);
    assert.equal(calls, 5);
    assert.match(events.join("\n"), /Runtime warning/);
    assert.doesNotMatch(events.join("\n"), /turn.completed/);
    assert.equal(store.listTurns("loop")[0]?.status, "interrupted");
    const next = create();
    assert.equal(calls, 5, "Restoring a transcript must never invoke a tool or provider");
    await assert.rejects(next.send("Continue", { streaming: false }), ToolLoopPausedError);
    assert.equal(calls, 6, "Restored loop evidence must not receive a fresh repetition allowance");
    fs.writeFileSync(path.join(workspace, "evidence.txt"), "changed evidence");
    let recoveredCalls = 0;
    const recovered = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      transcriptId: "loop", transcriptStore: store, modelResolver: { resolve: () => model },
      fetchImpl: async () => ++recoveredCalls === 1 ? reply("", 1, "changed") : reply("Recovered"),
    });
    assert.equal((await recovered.send("The file changed", { streaming: false })).response, "Recovered");
  });

  for (const stop of ["cancel", "reset", "invalid-summary"] as const) {
    it(`preserves stop semantics during compaction: ${stop}`, async t => {
      const { workspace, store } = fixture(t);
      const controller = new AbortController();
      let calls = 0;
      let summaries = 0;
      const adapter = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
        transcriptId: "stop", transcriptStore: store, modelResolver: { resolve: () => model },
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.tool_choice === "none") {
            summaries++;
            if (stop === "cancel") controller.abort();
            if (stop === "reset") adapter.reset({ clearPersistedState: true });
            return reply("", 999, "must-not-run");
          }
          assert.ok(++calls < 70, "A summary failure must not restart execution");
          return reply("", calls, `read-${calls}`);
        },
      });
      await assert.rejects(adapter.send("Inspect all lines", { streaming: false, signal: controller.signal }),
        stop === "invalid-summary" ? NativeContextLimitError : /abort|superseded|reset/i);
      assert.equal(summaries, 1);
      const turns = store.listTurns("stop");
      if (stop === "reset") assert.equal(turns.length, 0);
      else {
        assert.equal(turns[0]?.status, stop === "cancel" ? "cancelled" : "interrupted");
        assert.doesNotMatch(JSON.stringify(turns), /must-not-run/);
      }
    });
  }
});

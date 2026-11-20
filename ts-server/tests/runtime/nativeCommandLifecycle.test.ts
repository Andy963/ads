import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";

type Wire = "responses" | "chat";
function response(wire: Wire, tool?: { id: string; name: string; arguments: string }, text = "", streaming = false) {
  const body = wire === "responses" ? {
    id: "response-fixture", status: "completed", output: tool ? [{ type: "function_call", call_id: tool.id,
      name: tool.name, arguments: tool.arguments, status: "completed" }] : [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text }] }],
  } : { choices: [{ message: { role: "assistant", content: text || null,
    ...(tool ? { tool_calls: [{ id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments } }] } : {}) },
    finish_reason: tool ? "tool_calls" : "stop" }] };
  if (streaming) {
    const event = wire === "responses" ? { type: "response.completed", response: body }
      : { choices: [{ delta: { content: text, ...(tool ? { tool_calls: [{ index: 0, id: tool.id, type: "function",
        function: { name: tool.name, arguments: tool.arguments } }] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("Native command lifecycle integration", () => {
  for (const wire of ["chat", "responses"] as const) {
    for (const streaming of [false, true]) {
      for (const automatic of [false, true]) {
        it(`${wire} streaming=${streaming}: ${automatic ? "collects pending exits before accepting a final answer" : "waits without duplicate execution"}`, async t => {
          const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-lifecycle-"));
          t.after(() => { resetStateDatabaseForTests(); fs.rmSync(workspace, { recursive: true, force: true }); });
          const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
          const requests: Array<Record<string, any>> = [];
          const events: Array<{ type: string; item: Record<string, any> }> = [];
          const visibleTexts: string[] = [];
          const reply = (tool?: { id: string; name: string; arguments: string }, text = "") => response(wire, tool, text, streaming);
          const adapter = new NativeAgentAdapter({
            credentialOwner: "owner", workspaceRoot: workspace, transcriptId: "commands", transcriptStore: store,
            modelResolver: { resolve: () => ({ model: "fixture", provider: "test", baseUrl: "https://provider.test/v1",
              apiKey: "test-key", wireApi: wire, capabilities: { streaming: "supported", nonStreaming: "supported" } }) },
            fetchImpl: async (_url, init) => {
              const body = JSON.parse(String(init?.body));
              requests.push(body);
              if (requests.length === 1) return reply({ id: "exec-test", name: "exec_command", arguments: JSON.stringify({
                cmd: process.execPath, yield_time_ms: 1, args: ["-e", "const fs=require('fs');fs.appendFileSync('starts','x');const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);process.stdout.write('verified\\n');}},10);"],
              }) });
              const messages = wire === "responses" ? body.input : body.messages;
              const outputs = messages.filter((item: any) => wire === "responses" ? item.type === "function_call_output" : item.role === "tool");
              const latest = JSON.parse(wire === "responses" ? outputs.at(-1).output : outputs.at(-1).content);
              if (requests.length === 2) {
                assert.equal(latest.running, true);
                assert.equal(latest.exit_code, null);
                assert.equal(store.listTurns("commands")[0].entries.filter(entry => entry.kind === "command").length, 0);
                fs.writeFileSync(path.join(workspace, "release"), "");
                return automatic ? reply(undefined, "Premature success") : reply({
                  id: "wait-test", name: "wait_command", arguments: JSON.stringify({ session_id: latest.session_id }),
                });
              }
              assert.equal(requests.length, 3);
              assert.equal(latest.running, false);
              assert.equal(latest.exit_code, 0);
              assert.equal(latest.stdout, "verified");
              if (wire === "responses") {
                const calls = messages.filter((item: any) => item.type === "function_call");
                assert.deepEqual(calls.map((item: any) => item.call_id), outputs.map((item: any) => item.call_id));
                assert.deepEqual(calls.map((item: any) => item.name), ["exec_command", "wait_command"]);
              }
              return reply(undefined, "Verified success");
            },
          });
          adapter.onEvent(event => {
            const raw = event.raw as { type: string; item?: Record<string, any> };
            if (raw.item?.type === "command_execution") events.push(raw as typeof events[number]);
            if (raw.item?.type === "agent_message") visibleTexts.push(raw.item.text ?? "");
          });
          const result = await adapter.send("Run the verification and report the actual exit status", { streaming });
          assert.match(result.response, /Verified success/);
          assert.doesNotMatch(result.response, /Premature success/);
          assert.doesNotMatch(visibleTexts.join("\n"), /Premature success/);
          assert.equal(fs.readFileSync(path.join(workspace, "starts"), "utf8"), "x");
          assert.deepEqual(events.map(event => [event.type, event.item.id, event.item.status]), [
            ["item.started", "exec-test", "in_progress"],
            ["item.updated", "exec-test", "in_progress"],
            ["item.completed", "exec-test", "completed"],
          ]);
          const turn = store.listTurns("commands")[0];
          assert.equal(turn.status, "completed");
          const commands = turn.entries.filter(entry => entry.kind === "command");
          assert.equal(commands.length, 1);
          assert.equal(commands[0].exitCode, 0);
        });
      }
    }
  }

  for (const reason of ["provider failure", "cancellation", "reset"] as const) {
    it(`cleans up yielded processes after ${reason} without replaying side effects`, async t => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-cleanup-"));
      t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
      const controller = new AbortController();
      let requests = 0;
      let pid = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "owner", workspaceRoot: workspace, retryBackoffMs: [0],
        modelResolver: { resolve: () => ({ model: "fixture", provider: "test", baseUrl: "https://provider.test/v1",
          apiKey: "test-key", capabilities: { streaming: "unsupported", nonStreaming: "supported" } }) },
        fetchImpl: async () => {
          requests++;
          if (requests === 1) return response("chat", { id: "exec-test", name: "exec_command", arguments: JSON.stringify({
            cmd: process.execPath, yield_time_ms: 1, args: ["-e", "require('fs').writeFileSync('pid',String(process.pid));setInterval(()=>{},1000);"],
          }) });
          for (let i = 0; i < 500 && !fs.existsSync(path.join(workspace, "pid")); i++) await delay(10);
          pid = Number(fs.readFileSync(path.join(workspace, "pid"), "utf8"));
          if (reason === "cancellation") controller.abort();
          if (reason === "reset") adapter.reset({ clearPersistedState: true });
          return new Response("temporary failure", { status: 503 });
        },
      });
      await assert.rejects(adapter.send("Run a command", { signal: controller.signal, streaming: false }));
      assert.equal(requests, 2);
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    });
  }
});

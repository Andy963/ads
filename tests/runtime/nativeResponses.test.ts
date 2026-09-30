import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { createNativeModelResolver, type NativeModelConfig } from "../../server/runtime/modelResolver.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { createModelProviderStore } from "../../server/state/modelProviderStore.js";
import { createGlobalModelConfigStore } from "../../server/state/globalModelConfigStore.js";
import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";
import { NativeContextLimitError, projectNativeContext } from "../../server/runtime/nativeContextProjection.js";
import { completeNativeModel } from "../../server/runtime/nativeCompletion.js";
import type { NativeChatMessage } from "../../server/runtime/openAiCompatibleClient.js";
import type { NativeResponsesOutputItem } from "../../server/runtime/nativeResponsesTypes.js";

const outputMessage = (text: string): NativeResponsesOutputItem => ({
  type: "message", id: `msg-${text.length}`, role: "assistant", status: "completed", phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
});
const reasoning: NativeResponsesOutputItem = {
  type: "reasoning", id: "rs-private", summary: [], encrypted_content: "opaque-encrypted-reasoning",
};
const toolCall: NativeResponsesOutputItem = {
  type: "function_call", id: "fc-provider-item", call_id: "call-read", name: "read_file",
  arguments: '{"file":"note.txt"}', status: "completed",
};

describe("Native Responses integration", () => {
  it("preserves interrupted task evidence without replaying tools and isolates model switches", async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-responses-interrupted-"));
    t.after(() => { resetStateDatabaseForTests(); fs.rmSync(workspace, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(workspace, "note.txt"), "confirmed content");
    const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
    const model: NativeModelConfig = { model: "model-a", provider: "fixture", baseUrl: "https://provider.test/v1",
      apiKey: "fixture-key", wireApi: "responses" };
    const bodies: Array<Record<string, any>> = [];
    let calls = 0;
    const controller = new AbortController();
    const create = () => new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      transcriptId: "interrupted", transcriptStore: store, modelResolver: { resolve: () => model },
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        calls++;
        if (calls === 2) {
          controller.abort();
          throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        return Response.json({ id: `resp-${calls}`, status: "completed",
          output: calls === 1 ? [reasoning, toolCall] : [outputMessage("Recovered.")] });
      },
    });
    await assert.rejects(create().send("Read the note.", { streaming: false, signal: controller.signal }));
    assert.equal(store.listTurns("interrupted")[0]?.status, "cancelled");
    const restored = create();
    await restored.send("Continue.", { streaming: false });
    assert.equal(calls, 3);
    assert.deepEqual(bodies[2]!.input.find((item: any) => item.type === "reasoning"), reasoning);
    assert.equal(bodies[2]!.input.filter((item: any) => item.type === "function_call_output").length, 1);
    assert.match(JSON.stringify(bodies[2]!.input), /cancelled, not completed/);
    model.model = "model-b";
    await restored.send("Use another model.", { streaming: false });
    assert.doesNotMatch(JSON.stringify(bodies[3]), /opaque-encrypted-reasoning|rs-private|nativeResponses/);
    assert.equal(bodies[3]!.input.filter((item: any) => item.type === "function_call_output").length, 1);
  });

  for (const streaming of [false, true]) {
    it(`routes saved provider models through tool rounds and durable restore (streaming=${streaming})`, async t => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-responses-"));
      const requests: Array<Record<string, any>> = [];
      const server = http.createServer(async (req, res) => {
        try {
          assert.equal(req.url, "/v1/responses");
          assert.equal(req.headers.authorization, "Bearer fixture-private-key");
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          requests.push(body);
          assert.equal(body.store, false);
          assert.equal(body.max_output_tokens, 1_024);
          assert.equal(body.reasoning.effort, "high");
          assert.equal(body.previous_response_id, undefined);
          const output = requests.length === 1 ? [reasoning, outputMessage("Reading."), toolCall] : [outputMessage("Done.")];
          const response = { id: `resp-${requests.length}`, status: "completed", output,
            usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125 } };
          if (streaming) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
          } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(response));
          }
        } catch {
          res.writeHead(500);
          res.end("fixture assertion failed");
        }
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        resetStateDatabaseForTests();
        fs.rmSync(workspace, { recursive: true, force: true });
      });
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const dbPath = path.join(workspace, "state.db");
      const db = getStateDatabase(dbPath);
      fs.writeFileSync(path.join(workspace, "note.txt"), "confirmed content");
      createModelProviderStore(db).upsertProvider({ id: "responses-provider", name: "Responses", baseUrl,
        wireApi: "responses", isEnabled: true });
      createGlobalModelConfigStore(db).upsertModelConfig({ id: "responses-model", modelId: "upstream-model",
        providerId: "responses-provider", provider: "Responses", displayName: "Responses",
        isEnabled: true, isDefault: false, configJson: { max_input_tokens: 8_192, max_output_tokens: 1_024 } });
      createUpstreamCredentialStore(db, { pepper: "fixture-pepper" }).save("owner", {
        baseUrl, provider: "responses-provider", apiKey: "fixture-private-key",
      }, "responses-provider");
      const store = new NativeTranscriptStore(db);
      const createAdapter = () => {
        const adapter = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
          transcriptId: "responses-thread", transcriptStore: store,
          modelResolver: createNativeModelResolver({ owner: "owner", stateDbPath: dbPath,
            env: { ADS_WEB_SESSION_PEPPER: "fixture-pepper" } }),
        });
        adapter.setModel("responses-model");
        return adapter;
      };
      const adapter = createAdapter();
      const events: unknown[] = [];
      adapter.onEvent(event => events.push(event));
      const result = await adapter.send("Read the note.", { streaming });
      assert.equal(result.response, "Reading.Done.");
      assert.equal(result.usage?.input_tokens, 200);
      assert.equal(requests.length, 2);
      const secondInput = requests[1]!.input;
      assert.deepEqual(secondInput.find((item: any) => item.type === "reasoning"), reasoning);
      assert.equal(secondInput.find((item: any) => item.type === "function_call").call_id, "call-read");
      assert.match(secondInput.find((item: any) => item.type === "function_call_output").output, /confirmed content/);
      assert.doesNotMatch(JSON.stringify(events), /opaque-encrypted-reasoning/);
      assert.doesNotMatch(JSON.stringify(requests), /nativeResponses|fixture-private-key/);
      const stored = store.listTurns("responses-thread")[0]!;
      assert.equal(stored.messages[1]?.nativeResponses?.output[0]?.type, "reasoning");
      assert.doesNotMatch(JSON.stringify(stored), /fixture-private-key/);
      await createAdapter().send("Continue from the previous result.", { streaming });
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[2]!.input.find((item: any) => item.type === "reasoning"), reasoning);
      assert.equal(requests[2]!.input.filter((item: any) => item.type === "function_call_output").length, 1);
    });
  }

  it("retains opaque reasoning as fixed context while projecting only tool results", () => {
    const messages: NativeChatMessage[] = [
      { role: "user", content: "read" },
      { role: "assistant", content: null,
        tool_calls: [{ id: "call-read", type: "function", function: { name: "read_file", arguments: "{}" } }],
        nativeResponses: { scope: "scope", output: [reasoning, toolCall] } },
      { role: "tool", content: "x".repeat(8_000), tool_call_id: "call-read" },
    ];
    const projected = projectNativeContext(messages, { contextWindow: 512, reservedTokens: 64 });
    assert.equal(projected.diagnostic.truncatedToolOutputs, 1);
    assert.deepEqual(projected.messages[1]!.nativeResponses, messages[1]!.nativeResponses);
    assert.notEqual(projected.messages[1]!.nativeResponses, messages[1]!.nativeResponses);
    const large = structuredClone(messages);
    const item = large[1]!.nativeResponses!.output[0]!;
    if (item.type === "reasoning") item.encrypted_content = "x".repeat(20_000);
    assert.throws(() => projectNativeContext(large, { contextWindow: 512, reservedTokens: 64 }), NativeContextLimitError);
  });

  it("drops provider replay data when a tool-free final response violates the tool limit", async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-responses-final-"));
    t.after(() => { resetStateDatabaseForTests(); fs.rmSync(workspace, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(workspace, "note.txt"), "confirmed content");
    const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
    let calls = 0;
    const adapter = new NativeAgentAdapter({ credentialOwner: "owner", workspaceRoot: workspace,
      transcriptId: "final", transcriptStore: store, maxToolRounds: 1,
      modelResolver: { resolve: () => ({ model: "model", provider: "fixture", baseUrl: "https://provider.test/v1",
        apiKey: "fixture-key", wireApi: "responses" }) },
      fetchImpl: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        if (calls === 2) assert.equal(body.tool_choice, "none");
        if (calls > 2) assert.doesNotMatch(JSON.stringify(body.input), /call-forbidden/);
        return Response.json({ id: `resp-${calls}`, status: "completed", output: calls === 1
          ? [reasoning, toolCall] : calls === 2
            ? [{ ...toolCall, call_id: "call-forbidden", id: "fc-forbidden" }] : [outputMessage("Done.")] });
      },
    });
    const result = await adapter.send("Read the note.", { streaming: false });
    assert.match(result.response, /tool-round limit/);
    const messages = store.listTurns("final")[0]!.messages;
    assert.equal(messages.at(-1)?.nativeResponses, undefined);
    assert.equal(messages.filter(message => message.role === "tool").length, 1);
    await adapter.send("Continue.", { streaming: false });
    assert.equal(calls, 3);
  });

  it("never falls back to Chat when the Responses endpoint rejects a request", async () => {
    const urls: string[] = [];
    await assert.rejects(completeNativeModel({ wireApi: "responses", baseUrl: "https://provider.test/v1",
      apiKey: "key", model: "model", messages: [{ role: "user", content: "hello" }], tools: [], streaming: false,
      fetchImpl: async url => { urls.push(String(url)); return new Response("secret upstream failure", { status: 400 }); },
    }), /HTTP 400/);
    assert.deepEqual(urls, ["https://provider.test/v1/responses"]);
  });

  it("never sends Responses replay metadata to a Chat provider", async () => {
    let sent: Record<string, unknown> = {};
    await completeNativeModel({ baseUrl: "https://provider.test/v1", apiKey: "key", model: "model",
      messages: [{ role: "assistant", content: "Done.", nativeResponses: { scope: "scope", output: [reasoning] } }],
      tools: [], streaming: false,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] });
      },
    });
    assert.doesNotMatch(JSON.stringify(sent), /nativeResponses|encrypted|reasoning/);
  });
});

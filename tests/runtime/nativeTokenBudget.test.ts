import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { estimateNativeRequestTokens } from "../../server/runtime/nativeContextProjection.js";
import type { NativeChatMessage, NativeToolDefinition } from "../../server/runtime/openAiCompatibleClient.js";
import type { NativeModelConfig } from "../../server/runtime/modelResolver.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";

interface RequestBody {
  messages: NativeChatMessage[];
  tools?: NativeToolDefinition[];
  max_tokens: number;
}

const model: NativeModelConfig = {
  model: "test-model", provider: "test", baseUrl: "https://provider.test/v1", apiKey: "test-secret",
};

function reply(body: object): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("Native runtime token budgets", () => {
  const cases = [
    { name: "defaults", config: {}, env: {}, expected: 131_072 },
    { name: "small configured window", config: { contextWindow: 8_192 }, env: {}, expected: 4_096 },
    { name: "1M configured window", config: { contextWindow: 1_048_576, options: { maxTokens: 262_144 } },
      env: { ADS_NATIVE_CONTEXT_WINDOW: "2048", ADS_NATIVE_CONTEXT_RESERVED_TOKENS: "1000" }, expected: 262_144 },
    { name: "environment", config: {}, env: { ADS_NATIVE_CONTEXT_WINDOW: "8192", ADS_NATIVE_CONTEXT_RESERVED_TOKENS: "5000" }, expected: 5_000 },
    { name: "invalid environment", config: {}, env: { ADS_NATIVE_CONTEXT_WINDOW: "0", ADS_NATIVE_CONTEXT_RESERVED_TOKENS: "-1" }, expected: 131_072 },
  ];
  for (const testCase of cases) {
    it(`sends the same output cap reserved by projection: ${testCase.name}`, async t => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-token-budget-"));
      t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
      let request: RequestBody | undefined;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace, env: testCase.env,
        modelResolver: { resolve: () => ({ ...model, ...testCase.config }) },
        fetchImpl: async (_url, init) => {
          request = JSON.parse(String(init?.body));
          return reply({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
        },
      });
      await adapter.send("Inspect the configured token budget.", { streaming: false });
      assert.equal(request?.max_tokens, testCase.expected);
    });
  }

  for (const mode of ["reported", "missing-middle", "output-only"] as const) {
    it(`calibrates projected requests independently of billing and durable history: ${mode}`, async t => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-token-accounting-"));
      t.after(() => {
        resetStateDatabaseForTests();
        fs.rmSync(workspace, { recursive: true, force: true });
      });
      const fileContent = "x".repeat(12_000);
      fs.writeFileSync(path.join(workspace, "source.txt"), fileContent);
      const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
      const requests: RequestBody[] = [];
      let billedInput = 0;
      let billedOutput = 0;
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace,
        transcriptId: "accounting", transcriptStore: store, maxToolRounds: 3,
        modelResolver: { resolve: () => ({ ...model, contextWindow: 8_000, options: { maxTokens: 1_000 } }) },
        fetchImpl: async (_url, init) => {
          const body: RequestBody = JSON.parse(String(init?.body));
          if (!(body.tools?.length)) return reply({ choices: [{ message: { content: "Read source evidence; full results remain in execution history." }, finish_reason: "stop" }] });
          requests.push(body);
          const index = requests.length;
          assert.equal(body.max_tokens, 1_000);
          const promptTokens = estimateNativeRequestTokens(body.messages, body.tools) * 3;
          if (index > 1 && index <= 3 && mode !== "output-only") {
            assert.ok(promptTokens <= 7_000, `Request ${index} must fit the calibrated budget`);
            assert.ok(promptTokens > 6_700, `Request ${index} must not compound the ratio or use cumulative billing`);
          }
          const hasPrompt = mode !== "output-only" && !(mode === "missing-middle" && index === 2);
          const usage = { ...(hasPrompt ? { prompt_tokens: promptTokens } : {}), completion_tokens: 5_000 };
          billedInput += hasPrompt ? promptTokens : 0;
          billedOutput += usage.completion_tokens;
          return reply({
            choices: [{ message: index <= 3 ? { content: null, tool_calls: [{
              id: `read-${index}`, type: "function", function: { name: "read_file", arguments: '{"file":"source.txt"}' },
            }] } : { content: "done" }, finish_reason: index <= 3 ? "tool_calls" : "stop" }],
            usage,
          });
        },
      });
      const result = await adapter.send("Read the source file.", { streaming: false });
      assert.equal(result.response, "done", "Final-summary assertion failures must not be hidden by fallback handling");
      assert.equal(requests.length, 4);
      assert.ok(requests[3]?.tools?.length, "Tools remain available until natural completion");
      const secondTool = String(requests[1]?.messages.find(message => message.role === "tool")?.content);
      if (mode === "output-only") assert.ok(secondTool.includes(fileContent));
      else assert.match(secondTool, /Native context truncated/);
      assert.equal(result.usage?.input_tokens ?? 0, billedInput);
      assert.equal(result.usage?.output_tokens, billedOutput);
      const durable = store.listTurns("accounting")[0];
      assert.ok(durable?.messages.filter(message => message.role === "tool").every(message => String(message.content).includes(fileContent)));

      // A later user turn starts without the previous model request's calibration.
      await adapter.send(`New independent request. ${"y".repeat(12_000)}`, { streaming: false });
      assert.ok(estimateNativeRequestTokens(requests[4]!.messages, requests[4]!.tools) * 3 > 7_000);
    });
  }
});

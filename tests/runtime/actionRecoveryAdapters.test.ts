import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { LaneDispatchBus } from "../../server/actions/bus.js";
import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { runAgentTurn } from "../../server/agents/turn.js";
import type { AgentAdapter } from "../../server/agents/types.js";
import { CodexAppServerDaemonRegistry } from "../../server/codex/appServer/daemonRegistry.js";
import { CodexAppServerClient } from "../../server/codex/appServer/rpcClient.js";
import { getBus, setBusInstance } from "../../server/web/server/api/routes/actions.js";

const actionRecovery = { jobId: "blocked-job", promptId: "recovery-prompt" };
const contract = {
  issue_id: 567, title: "Approved issue", description: "Fix the blocked job", acceptance_criteria: ["Review is required"],
};
const queued = { ok: true, jobId: "new-job", status: "queued" as const };

function orchestratorFor(adapter: AgentAdapter): HybridOrchestrator {
  return {
    getActiveAgentId: () => adapter.id,
    onEvent: adapter.onEvent.bind(adapter),
    invokeAgent: (_id, input, options) => adapter.send(input, options),
  } as HybridOrchestrator;
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for fake Codex RPC");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("Actions recovery context through runtime adapters", () => {
  let workspace: string;
  let previousBus: LaneDispatchBus;
  let bus: {
    dispatchJob: ReturnType<typeof mock.fn>;
    dispatchRecoveryJob: ReturnType<typeof mock.fn>;
  };

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-recovery-adapters-"));
    previousBus = getBus();
    bus = {
      dispatchJob: mock.fn(() => queued),
      dispatchRecoveryJob: mock.fn(() => ({ ...queued, jobId: actionRecovery.jobId })),
    };
    setBusInstance(bus as unknown as LaneDispatchBus);
  });

  afterEach(() => {
    setBusInstance(previousBus);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function assertDispatches(): void {
    const common = {
      repoPath: workspace, authUserId: "trusted-owner", issueId: 567,
      issueTitle: contract.title, issueDescription: contract.description,
      acceptanceCriteria: contract.acceptance_criteria, jobKind: "github_issue",
    };
    assert.deepEqual(bus.dispatchRecoveryJob.mock.calls.map(call => call.arguments[0]), [{ ...actionRecovery, ...common }]);
    assert.deepEqual(bus.dispatchJob.mock.calls.map(call => call.arguments[0]), [{ projectId: workspace, ...common }]);
  }

  it("native sends keep recovery turn-local and reject model attempts to inject recovery", async () => {
    let requestIndex = 0;
    let currentArgs: Record<string, unknown> = contract;
    let toolOutput = "";
    const adapter = new NativeAgentAdapter({
      credentialOwner: "trusted-owner", authUserId: "trusted-owner", workspaceRoot: workspace,
      modelResolver: { resolve: () => ({
        model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
      }) },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (requestIndex++ === 0) assert.doesNotMatch(JSON.stringify(body), /blocked-job|recovery-prompt/);
        const needsTool = body.messages.at(-1).role === "user";
        if (!needsTool) toolOutput = body.messages.at(-1).content;
        const event = needsTool
          ? { choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "dispatch", function: {
            name: "dispatch_action_job", arguments: JSON.stringify(currentArgs),
          } }] }, finish_reason: "tool_calls" }] }
          : { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const orchestrator = orchestratorFor(adapter);
    for (const recovery of [actionRecovery, undefined]) {
      await runAgentTurn(orchestrator, "Dispatch the approved issue", { workspaceRoot: workspace, actionRecovery: recovery });
      assert.equal(JSON.parse(toolOutput).job_id, recovery ? actionRecovery.jobId : queued.jobId);
      currentArgs = { ...contract, actionRecovery: { jobId: "forged-job", promptId: "forged-prompt" } };
      await runAgentTurn(orchestrator, "Dispatch the approved issue", { workspaceRoot: workspace, actionRecovery: recovery });
      assert.match(toolOutput, /does not accept additional arguments/);
      currentArgs = contract;
    }
    assertDispatches();
  });

  it("Codex bridge uses trusted send context only and never retains recovery for the next turn", async t => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const client = new CodexAppServerClient();
    client.attach({ stdin, stdout, stderr, waitClose: async () => null });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => client });
    t.after(() => registry.stopAll());
    const requests: Array<{ id?: number | string; method?: string; params?: any; result?: any }> = [];
    const write = (message: Record<string, unknown>) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(request);
        if (["initialize", "thread/start", "turn/start"].includes(request.method)) {
          write({ id: request.id, result: request.method === "thread/start" ? { thread: { id: "thread" } } : {} });
        }
      }
    });
    const adapter = new CodexAppServerAdapter({
      projectId: "recovery-adapter", workspaceRoot: workspace, workingDirectory: workspace,
      authUserId: "trusted-owner", registry,
    });
    const orchestrator = orchestratorFor(adapter);
    for (const [index, recovery] of [actionRecovery, undefined].entries()) {
      const turnId = `turn-${index}`;
      const pending = runAgentTurn(orchestrator, "Dispatch the approved issue", {
        workspaceRoot: workspace, actionRecovery: recovery,
      });
      await waitUntil(() => requests.filter(request => request.method === "turn/start").length === index + 1);
      assert.doesNotMatch(JSON.stringify(requests.filter(request => request.method)), /blocked-job|recovery-prompt/);
      write({ method: "turn/started", params: { threadId: "thread", turn: { id: turnId } } });
      for (const injected of [false, true]) {
        const id = `rpc-${index}-${injected}`;
        write({ id, method: "item/tool/call", params: {
          threadId: "thread", turnId, callId: `dispatch-${injected}`, tool: "dispatch_action_job",
          arguments: injected ? { ...contract, jobId: "forged-job", promptId: "forged-prompt" } : contract,
        } });
        await waitUntil(() => requests.some(request => request.id === id));
        const response = requests.find(request => request.id === id)!.result;
        assert.equal(response.success, !injected);
        const output = response.contentItems[0].text;
        if (injected) assert.match(output, /does not accept additional arguments/);
        else assert.equal(JSON.parse(output).job_id, recovery ? actionRecovery.jobId : queued.jobId);
      }
      write({ method: "turn/completed", params: { threadId: "thread", turn: { id: turnId } } });
      await pending;
    }
    const dynamicTools = requests.find(request => request.method === "thread/start")!.params.dynamicTools;
    assert.deepEqual(dynamicTools.map((tool: { name: string }) => tool.name), ["dispatch_action_job"]);
    assertDispatches();
  });
});

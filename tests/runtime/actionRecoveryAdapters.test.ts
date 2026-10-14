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
import type { SandboxMode } from "../../server/config.js";
import type { SandboxPolicy } from "../../server/codex/appServer/protocol/v2/SandboxPolicy.js";

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
    let currentTool = "dispatch_action_job";
    let diagnostic = false;
    let toolOutput = "";
    const actionTools = { review_action: mock.fn(async () => ({ ok: true })), deliver_action: mock.fn(async () => ({ ok: true })) };
    fs.writeFileSync(path.join(workspace, "evidence.txt"), "Original evidence\n");
    const adapter = new NativeAgentAdapter({
      credentialOwner: "trusted-owner", authUserId: "trusted-owner", workspaceRoot: workspace,
      modelResolver: { resolve: () => ({
        model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test",
      }) },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const toolNames = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
        if (diagnostic) {
          assert.deepEqual(toolNames, ["read_execution_history", "read_file", "search", "dispatch_action_job"]);
        } else {
          for (const tool of ["exec_command", "wait_command", "cancel_command", "apply_patch", "review_action", "deliver_action"]) {
            assert.ok(toolNames.includes(tool), `Ordinary turn must expose ${tool}`);
          }
        }
        if (requestIndex++ === 0) assert.doesNotMatch(JSON.stringify(body), /blocked-job|recovery-prompt/);
        const needsTool = body.messages.at(-1).role === "user";
        if (!needsTool) toolOutput = body.messages.at(-1).content;
        const event = needsTool
          ? { choices: [{ delta: { tool_calls: [{ index: 0, type: "function", id: "dispatch", function: {
            name: currentTool, arguments: JSON.stringify(currentArgs),
          } }] }, finish_reason: "tool_calls" }] }
          : { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const orchestrator = orchestratorFor(adapter);
    for (const recovery of [actionRecovery, undefined]) {
      diagnostic = Boolean(recovery);
      await runAgentTurn(orchestrator, "Dispatch the approved issue", { workspaceRoot: workspace, actionRecovery: recovery, actionTools });
      assert.equal(JSON.parse(toolOutput).job_id, recovery ? actionRecovery.jobId : queued.jobId);
      currentArgs = { ...contract, actionRecovery: { jobId: "forged-job", promptId: "forged-prompt" } };
      await runAgentTurn(orchestrator, "Dispatch the approved issue", { workspaceRoot: workspace, actionRecovery: recovery, actionTools });
      assert.match(toolOutput, /does not accept additional arguments/);
      currentArgs = contract;
      if (recovery) {
        for (const [name, args] of [
          ["exec_command", { cmd: "gh pr merge 567 --merge" }],
          ["exec_command", { cmd: "gh issue close 567" }],
          ["apply_patch", { patch: "*** Begin Patch\n*** Update File: evidence.txt\n@@\n-Original evidence\n+Modified evidence\n*** End Patch" }],
          ["review_action", {}], ["deliver_action", {}],
        ] as const) {
          currentTool = name;
          currentArgs = args;
          await runAgentTurn(orchestrator, "Diagnose the blocked job", { workspaceRoot: workspace, actionRecovery: recovery, actionTools });
          assert.match(toolOutput, /unavailable during Actions recovery diagnosis/);
        }
        assert.equal(fs.readFileSync(path.join(workspace, "evidence.txt"), "utf8"), "Original evidence\n");
        assert.equal(actionTools.review_action.mock.callCount(), 0);
        assert.equal(actionTools.deliver_action.mock.callCount(), 0);
        currentTool = "dispatch_action_job";
        currentArgs = contract;
      }
    }
    currentTool = "exec_command";
    currentArgs = { cmd: process.execPath, args: ["-e", "process.stdout.write('ordinary-command')"] };
    await runAgentTurn(orchestrator, "Run an ordinary command", { workspaceRoot: workspace, actionTools });
    assert.match(toolOutput, /ordinary-command/);
    assertDispatches();
  });

  for (const sandboxMode of ["read-only", "workspace-write", "danger-full-access"] satisfies SandboxMode[]) {
    for (const resumed of [false, true]) {
      it(`Codex restores ${sandboxMode} after recovery and rejects escalation (resumed: ${resumed})`, async t => {
        const normalSandbox: SandboxPolicy = sandboxMode === "danger-full-access" ? { type: "dangerFullAccess" }
          : sandboxMode === "read-only" ? { type: "readOnly", networkAccess: true }
            : { type: "workspaceWrite", networkAccess: true, writableRoots: [path.join(workspace, "allowed")], excludeTmpdirEnvVar: true, excludeSlashTmp: true };
        const actionTools = { review_action: mock.fn(async () => ({ ok: true })), deliver_action: mock.fn(async () => ({ ok: true })) };
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const client = new CodexAppServerClient();
        client.attach({ stdin, stdout, stderr, waitClose: async () => null });
        const registry = new CodexAppServerDaemonRegistry({ factory: () => client });
        t.after(() => registry.stopAll());
        const requests: Array<{ id?: number | string; method?: string; params?: any; result?: any; error?: { code: number } }> = [];
        const write = (message: Record<string, unknown>) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
        let buffer = "";
        stdin.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const request = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            requests.push(request);
            if (["initialize", "thread/start", "thread/resume", "turn/start"].includes(request.method)) {
              if (request.method.startsWith("thread/")) {
                assert.equal(request.params.sandbox, sandboxMode);
                assert.equal(request.params.approvalPolicy, "untrusted");
              }
              write({ id: request.id, result: request.method.startsWith("thread/")
                ? { thread: { id: "thread" }, sandbox: normalSandbox, approvalPolicy: "untrusted" } : {} });
            }
          }
        });
        const adapter = new CodexAppServerAdapter({
          projectId: "recovery-adapter", workspaceRoot: workspace, workingDirectory: workspace,
          authUserId: "trusted-owner", registry, sandboxMode, resumeThreadId: resumed ? "thread" : undefined,
        });
        const orchestrator = orchestratorFor(adapter);
        for (const [index, recovery] of [actionRecovery, undefined].entries()) {
          const turnId = `turn-${index}`;
          const pending = runAgentTurn(orchestrator, "Dispatch the approved issue", {
            workspaceRoot: workspace, actionRecovery: recovery, actionTools,
          });
          await waitUntil(() => requests.filter(request => request.method === "turn/start").length === index + 1);
          const turnParams = requests.filter(request => request.method === "turn/start")[index].params;
          assert.equal(turnParams.threadId, "thread");
          assert.deepEqual(turnParams.sandboxPolicy, recovery ? { type: "readOnly", networkAccess: false } : normalSandbox);
          assert.equal(turnParams.approvalPolicy, recovery ? "never" : "untrusted");
          assert.doesNotMatch(JSON.stringify(requests.filter(request => request.method)), /blocked-job|recovery-prompt/);
          write({ method: "turn/started", params: { threadId: "thread", turn: { id: turnId } } });
          for (const [attempt, method, extra] of [
            ["merge", "item/commandExecution/requestApproval", { command: "gh pr merge 567 --merge" }],
            ["close", "item/commandExecution/requestApproval", { command: "gh issue close 567", additionalPermissions: { network: { enabled: true } } }],
            ["edit", "item/fileChange/requestApproval", { grantRoot: workspace }],
            ["permissions", "item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { write: [workspace] } } }],
          ] as const) {
            const id = `approval-${index}-${attempt}`;
            write({ id, method, params: { threadId: "thread", turnId, itemId: attempt, ...extra } });
            await waitUntil(() => requests.some(request => request.id === id));
            const response = requests.find(request => request.id === id)!;
            if (attempt === "permissions") {
              if (recovery) assert.deepEqual(response.result, { permissions: {}, scope: "turn" });
              else assert.equal(response.error?.code, -32601);
            } else assert.equal(response.result.decision, recovery ? "decline" : "accept");
          }
          for (const tool of ["exec_command", "apply_patch", "review_action", "deliver_action"]) {
            const id = `tool-${index}-${tool}`;
            write({ id, method: "item/tool/call", params: { threadId: "thread", turnId, callId: id, tool, arguments: {} } });
            await waitUntil(() => requests.some(request => request.id === id));
            const result = requests.find(request => request.id === id)!.result;
            assert.equal(result.success, !recovery && (tool === "review_action" || tool === "deliver_action"));
          }
          if (recovery) {
            assert.equal(actionTools.review_action.mock.callCount(), 0);
            assert.equal(actionTools.deliver_action.mock.callCount(), 0);
          }
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
        if (!resumed) {
          const dynamicTools = requests.find(request => request.method === "thread/start")!.params.dynamicTools;
          assert.deepEqual(dynamicTools.map((tool: { name: string }) => tool.name), ["dispatch_action_job"]);
        }
        assert.equal(requests.filter(request => request.method === "thread/start").length, resumed ? 0 : 1);
        assert.equal(requests.filter(request => request.method === "thread/resume").length, resumed ? 1 : 0);
        assert.equal(actionTools.review_action.mock.callCount(), 1);
        assert.equal(actionTools.deliver_action.mock.callCount(), 1);
        assertDispatches();
      });
    }
  }
});

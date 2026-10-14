import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LaneDispatchBus } from "../../server/actions/bus.js";
import type { ActionRecoveryContext, ActionTools } from "../../server/agents/actionTools.js";
import type { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { runAgentTurn } from "../../server/agents/turn.js";
import type { AgentSendOptions } from "../../server/agents/types.js";
import { builtinDynamicTools, createBuiltinToolBridge } from "../../server/codex/appServer/builtinTools.js";
import { NativeToolExecutor, NATIVE_TOOL_DEFINITIONS } from "../../server/runtime/tools.js";
import { executeToolDirectives } from "../../server/skills/builtinTools.js";
import { BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool, type BuiltinToolContext } from "../../server/tools/builtins.js";
import { getBus, setBusInstance } from "../../server/web/server/api/routes/actions.js";

const actionRecovery: ActionRecoveryContext = { jobId: "blocked-job", promptId: "recovery-prompt" };
const contract = {
  issue_id: 567,
  title: " Recover the approved issue ",
  description: " Fix the blocked Actions job without bypassing review ",
  acceptance_criteria: [" Preserve review gates "],
};
const queued = { ok: true, jobId: "queued-job", status: "queued" as const };

function directive(args: Record<string, unknown>): string {
  const { description, ...attributes } = args;
  const attrs = Object.entries(attributes).map(([key, value]) => {
    const text = Array.isArray(value) ? value.join("|") : String(value);
    return `${key}="${text}"`;
  }).join(" ");
  return `<<<tool.dispatch_action_job ${attrs}>>>\n${description ?? ""}\n>>>`;
}

const entryPoints: Record<string, (args: Record<string, unknown>, context: BuiltinToolContext) => Promise<string>> = {
  builtin: async (args, context) => JSON.stringify(executeBuiltinTool("dispatch_action_job", args, context)),
  native: async (args, context) => {
    const executor = new NativeToolExecutor(context);
    try {
      return (await executor.execute({
        id: "dispatch", type: "function",
        function: { name: "dispatch_action_job", arguments: JSON.stringify(args) },
      })).output;
    } finally {
      await executor.dispose();
    }
  },
  codex: async (args, context) => {
    const bridge = createBuiltinToolBridge({
      context,
      scope: () => ({ threadId: "thread", turnId: "turn", active: true }),
      markSideEffect: () => {},
    });
    const result = bridge.handle({
      threadId: "thread", turnId: "turn", callId: "dispatch",
      tool: "dispatch_action_job", arguments: args,
    });
    const content = result.contentItems[0];
    assert.equal(content.type, "inputText");
    if (!result.success) throw new Error(content.text);
    return content.text;
  },
  directive: async (args, context) => {
    const [result] = await executeToolDirectives({ ...context, text: directive(args) });
    if (result.includes("failed:")) throw new Error(result);
    return result;
  },
};

describe("trusted Actions recovery plumbing", () => {
  let workspace: string;
  let previousBus: LaneDispatchBus;
  let bus: {
    dispatchJob: ReturnType<typeof mock.fn>;
    dispatchRecoveryJob: ReturnType<typeof mock.fn>;
  };
  let context: BuiltinToolContext;

  const dispatchArgs = () => ({
    repoPath: workspace, authUserId: "trusted-owner", issueId: 567,
    issueTitle: "Recover the approved issue",
    issueDescription: "Fix the blocked Actions job without bypassing review",
    acceptanceCriteria: ["Preserve review gates"], jobKind: "github_issue",
  });

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-action-recovery-tools-"));
    previousBus = getBus();
    bus = {
      dispatchJob: mock.fn(() => queued),
      dispatchRecoveryJob: mock.fn(() => ({ ...queued, jobId: actionRecovery.jobId })),
    };
    setBusInstance(bus as unknown as LaneDispatchBus);
    context = { workspaceRoot: workspace, authUserId: "trusted-owner" };
  });

  afterEach(() => {
    setBusInstance(previousBus);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("does not expose recovery controls or review bypasses in either tool schema", () => {
    const expected = ["issue_id", "title", "description", "acceptance_criteria", "kind"];
    assert.deepEqual(BUILTIN_TOOL_DEFINITIONS.map(tool => tool.function.name), ["dispatch_action_job"]);
    for (const schema of [
      BUILTIN_TOOL_DEFINITIONS[0].function.parameters,
      NATIVE_TOOL_DEFINITIONS.find(tool => tool.function.name === "dispatch_action_job")!.function.parameters,
      builtinDynamicTools()[0].inputSchema as Record<string, unknown>,
    ]) {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(Object.keys(schema.properties as object), expected);
    }
    assert.deepEqual(builtinDynamicTools().map(tool => tool.name), ["dispatch_action_job"]);
  });

  for (const [name, invoke] of Object.entries(entryPoints)) {
    it(`${name}: routes trusted recovery with validated arguments and leaves ordinary dispatch unchanged`, async () => {
      const recovered = await invoke(contract, { ...context, actionRecovery });
      assert.match(recovered, /blocked-job/);
      assert.equal(bus.dispatchJob.mock.callCount(), 0);
      assert.deepEqual(bus.dispatchRecoveryJob.mock.calls.map(call => call.arguments[0]), [
        { ...actionRecovery, ...dispatchArgs() },
      ]);
      const ordinary = await invoke(contract, context);
      assert.match(ordinary, /queued-job/);
      assert.equal(bus.dispatchRecoveryJob.mock.callCount(), 1);
      assert.deepEqual(bus.dispatchJob.mock.calls.map(call => call.arguments[0]), [
        { projectId: workspace, ...dispatchArgs() },
      ]);
    });

    it(`${name}: preserves local prompt defaults during recovery`, async () => {
      await invoke({ title: "Local task", description: "Complete local task", acceptance_criteria: [], kind: "local_prompt" },
        { ...context, actionRecovery });
      assert.deepEqual(bus.dispatchRecoveryJob.mock.calls[0].arguments[0], {
        ...actionRecovery, repoPath: workspace, authUserId: "trusted-owner", issueId: null,
        issueTitle: "Local task", issueDescription: "Complete local task", acceptanceCriteria: [], jobKind: "local_prompt",
      });
      assert.equal(bus.dispatchJob.mock.callCount(), 0);
    });

    it(`${name}: rejects model-injected recovery fields with and without trusted context`, async () => {
      for (const recovery of [undefined, actionRecovery]) {
        for (const key of ["actionRecovery", "action_recovery", "jobId", "job_id", "promptId", "prompt_id", "skip_review"]) {
          await assert.rejects(invoke({ ...contract, [key]: "forged-recovery" }, { ...context, actionRecovery: recovery }),
            /does not accept additional arguments/);
        }
      }
      assert.equal(bus.dispatchRecoveryJob.mock.callCount(), 0);
      assert.equal(bus.dispatchJob.mock.callCount(), 0);
    });

    it(`${name}: applies existing validation before either dispatch route`, async () => {
      for (const args of [
        { title: "Missing criteria", description: "Complete task" },
        { ...contract, description: " " }, { ...contract, acceptance_criteria: [] },
        { ...contract, issue_id: -1 }, { ...contract, kind: "recovery" },
      ]) {
        await assert.rejects(invoke(args, { ...context, actionRecovery }));
      }
      assert.equal(bus.dispatchRecoveryJob.mock.callCount(), 0);
      assert.equal(bus.dispatchJob.mock.callCount(), 0);
    });

    it(`${name}: never falls back to ordinary dispatch after recovery fails`, async () => {
      bus.dispatchRecoveryJob.mock.mockImplementation(() => { throw new Error("private-recovery-error"); });
      await assert.rejects(invoke(contract, { ...context, actionRecovery }), (error: Error) => {
        assert.match(error.message, /Unable to dispatch Actions job/);
        assert.doesNotMatch(error.message, /private-recovery-error/);
        return true;
      });
      assert.equal(bus.dispatchRecoveryJob.mock.callCount(), 1);
      assert.equal(bus.dispatchJob.mock.callCount(), 0);
    });
  }

  for (const agentId of ["codex", "native"]) {
    it(`runAgentTurn forwards both trusted options and recovery text directives for ${agentId}`, async () => {
      const actionTools: ActionTools = {
        review_action: async () => ({ ok: true }), deliver_action: async () => ({ ok: true }),
      };
      const invokeAgent = mock.fn(async (_id: string, _input: unknown, options: AgentSendOptions) => {
        assert.equal(options.actionRecovery, actionRecovery);
        assert.equal(options.actionTools, actionTools);
        return { response: directive(contract), usage: null, agentId };
      });
      const orchestrator = {
        getActiveAgentId: () => agentId, onEvent: () => () => {}, invokeAgent,
      } as unknown as HybridOrchestrator;
      const result = await runAgentTurn(orchestrator, "Recover the approved issue", {
        ...context, actionRecovery, actionTools,
      });
      assert.equal(invokeAgent.mock.callCount(), 1);
      assert.equal(result.response, "tool.dispatch_action_job: ok (job_id: blocked-job, status: queued)");
      assert.deepEqual(bus.dispatchRecoveryJob.mock.calls[0].arguments[0], { ...actionRecovery, ...dispatchArgs() });
      assert.equal(bus.dispatchJob.mock.callCount(), 0);
    });
  }
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NATIVE_TOOL_DEFINITIONS, NativeToolExecutor } from "../../server/runtime/tools.js";
import { ACTION_TOOL_DEFINITIONS, BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool } from "../../server/tools/builtins.js";

describe("Acopilot implementation and review tools", () => {
  it("retires asynchronous dispatch and exposes only in-session workflow tools", () => {
    assert.deepEqual(BUILTIN_TOOL_DEFINITIONS, []);
    assert.deepEqual(ACTION_TOOL_DEFINITIONS.map((tool) => tool.function.name), [
      "begin_implementation",
      "review_action",
    ]);
    assert.equal(NATIVE_TOOL_DEFINITIONS.some((tool) => tool.function.name === "dispatch_action_job"), false);
  });

  it("validates an Issue id and invokes the task-slot guard", async () => {
    const calls: Array<{ issue_id: number }> = [];
    const actionTools = {
      review_action: async () => ({ ok: true }),
      begin_implementation: async (input: { issue_id: number }) => {
        calls.push(input);
        return { ok: true, branch: "dev" };
      },
    };

    const result = await executeBuiltinTool(
      "begin_implementation",
      { issue_id: 516 },
      { workspaceRoot: "/repo", actionTools },
    );
    assert.deepEqual(result, { ok: true, branch: "dev" });
    assert.deepEqual(calls, [{ issue_id: 516 }]);
    await assert.rejects(
      executeBuiltinTool("begin_implementation", { issue_id: "516" }, { workspaceRoot: "/repo", actionTools }),
      /positive integer issue_id/,
    );
  });

  it("passes task-slot arguments through the native runtime", async () => {
    const calls: Array<{ issue_id: number }> = [];
    const executor = new NativeToolExecutor({
      workspaceRoot: process.cwd(),
      actionTools: {
        review_action: async () => ({ ok: true }),
        begin_implementation: async (input) => {
          calls.push(input);
          return { ok: true, issueId: input.issue_id };
        },
      },
    });
    try {
      const result = await executor.execute({
        id: "begin-516",
        type: "function",
        function: { name: "begin_implementation", arguments: JSON.stringify({ issue_id: 516 }) },
      });
      assert.deepEqual(JSON.parse(result.output), { ok: true, issueId: 516 });
      assert.deepEqual(calls, [{ issue_id: 516 }]);
    } finally {
      await executor.dispose();
    }
  });

  it("keeps Acopilot workflow tools unavailable outside an Acopilot session", async () => {
    await assert.rejects(
      executeBuiltinTool("review_action", {}, { workspaceRoot: "/repo" }),
      /Acopilot workflow tools are unavailable in this lane/,
    );
    await assert.rejects(
      executeBuiltinTool("begin_implementation", { issue_id: 1 }, { workspaceRoot: "/repo" }),
      /Acopilot workflow tools are unavailable in this lane/,
    );
  });

  it("rejects the retired dispatch tool", async () => {
    await assert.rejects(
      executeBuiltinTool("dispatch_action_job", {}, { workspaceRoot: "/repo" }),
      /Unknown built-in tool/,
    );
  });
});

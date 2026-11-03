import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NATIVE_TOOL_DEFINITIONS, NativeToolExecutor } from "../../server/runtime/tools.js";
import { BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool } from "../../server/tools/builtins.js";

describe("Acopilot built-in tools", () => {
  it("always exposes review_action as a built-in tool", () => {
    assert.deepEqual(
      BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.function.name),
      ["review_action"],
    );
    assert.equal(NATIVE_TOOL_DEFINITIONS.some((tool) => tool.function.name === "dispatch_action_job"), false);
  });

  it("passes review_action through the native runtime", async () => {
    let calls = 0;
    const executor = new NativeToolExecutor({
      workspaceRoot: process.cwd(),
      actionTools: {
        review_action: async () => {
          calls += 1;
          return { ok: true, verdict: { status: "PASS", summary: "All checks pass." } };
        },
      },
    });
    try {
      const result = await executor.execute({
        id: "review-current-pr",
        type: "function",
        function: { name: "review_action", arguments: "{}" },
      });
      assert.equal(result.output, "review_action completed.\nStatus: PASS.\nSummary: All checks pass.");
      assert.equal(calls, 1);
    } finally {
      await executor.dispose();
    }
  });

  it("reports missing project context instead of hiding the tool", async () => {
    await assert.rejects(
      executeBuiltinTool("review_action", {}, { workspaceRoot: "/repo" }),
      /review_action is unavailable without an authenticated Acopilot project context/,
    );
  });

  it("rejects the retired dispatch tool", async () => {
    await assert.rejects(
      executeBuiltinTool("dispatch_action_job", {}, { workspaceRoot: "/repo" }),
      /Unknown built-in tool/,
    );
  });
});

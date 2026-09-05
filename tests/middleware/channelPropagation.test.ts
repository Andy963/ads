import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCoreMiddlewarePipeline, createCfMemMiddleware } from "../../server/middleware/index.js";
import type { TurnContext } from "../../server/middleware/types.js";
import type { ThreadItem } from "../../server/agents/protocol/types.js";

describe("Middleware channel propagation & security guardrails", () => {
  it("executes semantic memory recall and safety guardrails for channel=telegram", async () => {
    const recalledContexts: string[] = [];
    const cfMem = createCfMemMiddleware({
      fetchSemanticContext: async (ctx) => {
        recalledContexts.push(ctx.channel);
        return "Relevant prior discussion about DB indexing";
      },
    });

    const pipeline = createCoreMiddlewarePipeline({
      includeGlobalRules: true,
    });
    pipeline.use(cfMem);

    const ctx: TurnContext = {
      turnId: "tg-turn-1",
      sessionId: "tg-session-42",
      workspaceRoot: "/test/workspace",
      channel: "telegram",
      prompt: "How should I structure the migration?",
    };

    // BeforeInput: should execute memory recall and prepend context
    const modifiedPrompt = await pipeline.executeBeforeInput(ctx);
    assert.equal(recalledContexts.length, 1);
    assert.equal(recalledContexts[0], "telegram");
    assert.ok(modifiedPrompt.includes("<recalled_memory>"));
    assert.ok(modifiedPrompt.includes("Relevant prior discussion about DB indexing"));
    assert.ok(modifiedPrompt.includes("How should I structure the migration?"));

    // ItemStart: safety guardrails must block dangerous system commands
    const dangerousItem: ThreadItem = {
      type: "command_execution",
      command: "rm -rf state.db",
    } as unknown as ThreadItem;
    const blockedResult = await pipeline.executeItemStart(ctx, dangerousItem);
    assert.equal(blockedResult.blockExecution, true);
    assert.match(blockedResult.reason ?? "", /Command blocked by security rule/);

    // ItemStart: safe commands should be permitted
    const safeItem: ThreadItem = {
      type: "command_execution",
      command: "ls -la src/",
    } as unknown as ThreadItem;
    const allowedResult = await pipeline.executeItemStart(ctx, safeItem);
    assert.equal(allowedResult.blockExecution, false);
  });
});

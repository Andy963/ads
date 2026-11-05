import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCoreMiddlewarePipeline } from "../../server/middleware/index.js";
import type { TurnContext } from "../../server/middleware/types.js";

describe("Core standalone operability without Telegram connector", () => {
  it("initializes and executes core MiddlewarePipeline when telegram is absent", async () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    const savedChat = process.env.TELEGRAM_ALLOWED_USER_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_ID;

    try {
      const pipeline = createCoreMiddlewarePipeline({
        includeGlobalRules: true,
        includeContextArtifact: true,
      });

      const ctx: TurnContext = {
        turnId: "web-turn-standalone",
        sessionId: "web-session-1",
        workspaceRoot: "/tmp/workspace",
        channel: "web",
        prompt: "echo 'hello world'",
      };

      const prompt = await pipeline.executeBeforeInput(ctx);
      assert.equal(prompt, "echo 'hello world'");

      await pipeline.executeTurnStart(ctx);
      await pipeline.executeAfterOutput(ctx, "hello world output with PR https://github.com/Andy963/ads/pull/1");

      // The core pipeline produces real guardrail decisions without any
      // connector: dangerous commands are blocked at the item boundary and
      // benign ones pass through.
      const blocked = await pipeline.executeItemStart(ctx, {
        type: "command_execution",
        id: "cmd-blocked",
        command: "rm -f state.db",
      });
      assert.equal(blocked.blockExecution, true);
      assert.match(blocked.reason ?? "", /Command blocked by security rule/);

      const allowed = await pipeline.executeItemStart(ctx, {
        type: "command_execution",
        id: "cmd-allowed",
        command: "echo 'hello world'",
      });
      assert.equal(allowed.blockExecution, false);
    } finally {
      if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
      if (savedChat) process.env.TELEGRAM_ALLOWED_USER_ID = savedChat;
    }
  });

});

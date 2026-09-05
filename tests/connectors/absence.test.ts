import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCoreMiddlewarePipeline } from "../../server/middleware/index.js";
import { dispatchTaskTerminalEvent } from "../../server/web/taskNotifications/taskNotificationDispatcher.js";
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

      // Should not throw or fail
      assert.ok(true);
    } finally {
      if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
      if (savedChat) process.env.TELEGRAM_ALLOWED_USER_ID = savedChat;
    }
  });

  it("task notifications gracefully no-op when telegram env is absent", () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;

    try {
      const dummyLogger = {
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
      };

      // Dispatch event should not throw
      assert.doesNotThrow(() => {
        dispatchTaskTerminalEvent({
          taskId: "task-standalone-1",
          status: "completed",
          workspaceRoot: "/tmp/workspace",
        }, { logger: dummyLogger });
      });
    } finally {
      if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    }
  });
});

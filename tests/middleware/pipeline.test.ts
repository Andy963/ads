import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MiddlewarePipeline,
  createMiddlewarePipeline,
  createGlobalRulesMiddleware,
  createContextArtifactMiddleware,
  createCfMemMiddleware,
  type TurnContext,
  type AdsMiddleware,
} from "../../server/middleware/index.js";
import { runAgentTurn } from "../../server/agents/turn.js";
import { createRuleEnforcementGate } from "../../server/rules/enforcementGate.js";

describe("MiddlewarePipeline & Core Middlewares", () => {
  const baseCtx: TurnContext = {
    turnId: "turn-1",
    sessionId: "sess-1",
    workspaceRoot: os.tmpdir(),
    channel: "web",
    prompt: "original prompt",
  };

  it("executes onBeforeInput in order and chains prompt modifications", async () => {
    const mw1: AdsMiddleware = {
      name: "mw1",
      onBeforeInput: (ctx) => ({ modifiedPrompt: `[mw1] ${ctx.prompt}` }),
    };
    const mw2: AdsMiddleware = {
      name: "mw2",
      onBeforeInput: (ctx) => ({ modifiedPrompt: `${ctx.prompt} [mw2]` }),
    };

    const pipeline = createMiddlewarePipeline([mw1, mw2]);
    const result = await pipeline.executeBeforeInput(baseCtx);

    assert.equal(result, "[mw1] original prompt [mw2]");
  });

  it("executes onTurnStart across all registered middlewares", async () => {
    const calls: string[] = [];
    const mw1: AdsMiddleware = {
      name: "mw1",
      onTurnStart: () => {
        calls.push("mw1");
      },
    };
    const mw2: AdsMiddleware = {
      name: "mw2",
      onTurnStart: () => {
        calls.push("mw2");
      },
    };

    const pipeline = new MiddlewarePipeline([mw1, mw2]);
    await pipeline.executeTurnStart(baseCtx);

    assert.deepEqual(calls, ["mw1", "mw2"]);
  });

  it("intercepts and blocks dangerous commands via globalRulesMiddleware in onItemStart", async () => {
    const rulesMw = createGlobalRulesMiddleware();
    const pipeline = createMiddlewarePipeline([rulesMw]);

    const safeResult = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "git status",
    });
    assert.equal(safeResult.blockExecution, false);

    const blockedResult = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "pkill -f ads",
    });
    assert.equal(blockedResult.blockExecution, true);
    assert.match(blockedResult.reason ?? "", /blocked by security rule/i);

    const blockedSystemctl = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "systemctl --user stop ads-web",
    });
    assert.equal(blockedSystemctl.blockExecution, true);

    for (const command of [
      "killall ads-web",
      "pkill -f cli.js web",
      "pkill -f \\\nads",
      "kill -TERM $(pgrep -f ads-tg)",
      "kill -TERM $(cat /run/ads.pid)",
      "systemctl --user disable ads-tg",
      "systemctl mask ads-web",
      "systemctl --user kill ads-web",
    ]) {
      const result = await pipeline.executeItemStart(baseCtx, {
        type: "command_execution",
        command,
      });
      assert.equal(result.blockExecution, true, command);
    }

    const blockedRmDb = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "rm -f state.db",
    });
    assert.equal(blockedRmDb.blockExecution, true);
    assert.match(blockedRmDb.reason ?? "", /blocked by security rule/i);

    const blockedTruncateSqlite = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "truncate -s 0 test.sqlite",
    });
    assert.equal(blockedTruncateSqlite.blockExecution, true);

    const blockedRedirectDb = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "echo test > state.sqlite3",
    });
    assert.equal(blockedRedirectDb.blockExecution, true);

    const blockedQuotedRedirect = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "echo test > \"state.db\"",
    });
    assert.equal(blockedQuotedRedirect.blockExecution, true);

    const blockedSqliteWrite = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "sqlite3 state.db 'UPDATE settings SET value = 1'",
    });
    assert.equal(blockedSqliteWrite.blockExecution, true);

    for (const command of [
      "cat state.db",
      "sqlite3 state.db 'SELECT name FROM sqlite_master'",
      "systemctl --user status ads-web",
      "git status",
    ]) {
      const result = await pipeline.executeItemStart(baseCtx, {
        type: "command_execution",
        command,
      });
      assert.equal(result.blockExecution, false, command);
    }
  });

  it("applies the same built-in safety decision without reading rule state", () => {
    const gate = createRuleEnforcementGate({ mode: "observe" });
    const blocked = gate.evaluate({
      agent: "codex",
      channel: "web",
      workspace: baseCtx.workspaceRoot,
      tool: "shell",
      command: "rm -f state.db",
      userExplicitlyApproved: false,
    });
    assert.equal(blocked.decision, "deny");
    assert.equal(blocked.effectiveDecision, "deny");
    assert.equal(blocked.hits[0]?.ruleId, "builtin-security");

    const allowed = gate.evaluate({
      agent: "codex",
      channel: "web",
      workspace: baseCtx.workspaceRoot,
      tool: "shell",
      command: "sqlite3 state.db 'SELECT 1'",
      userExplicitlyApproved: false,
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.effectiveDecision, "allow");
    assert.deepEqual(allowed.hits, []);
  });

  it("spills oversized outputs to disk artifacts via contextArtifactMiddleware in onItemEnd", async () => {
    const tmpArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-artifact-test-"));
    try {
      const artifactMw = createContextArtifactMiddleware({
        maxOutputBytes: 100,
        artifactsDir: tmpArtifactDir,
      });
      const pipeline = createMiddlewarePipeline([artifactMw]);

      const smallOutput = "short output";
      const smallResult = await pipeline.executeItemEnd(baseCtx, {
        type: "command_execution",
        command: "echo test",
        aggregated_output: smallOutput,
      });
      assert.equal(smallResult.modifiedOutput, undefined);

      const largeOutput = "A".repeat(500);
      const largeResult = await pipeline.executeItemEnd(baseCtx, {
        type: "command_execution",
        command: "cat large.txt",
        aggregated_output: largeOutput,
      });
      assert.ok(largeResult.modifiedOutput);
      assert.match(largeResult.modifiedOutput, /Output truncated: 500 characters/);
      assert.match(largeResult.modifiedOutput, /saved to artifact:/);

      const files = fs.readdirSync(tmpArtifactDir);
      assert.equal(files.length, 1);
      const savedContent = fs.readFileSync(path.join(tmpArtifactDir, files[0]!), "utf8");
      assert.equal(savedContent, largeOutput);
    } finally {
      fs.rmSync(tmpArtifactDir, { recursive: true, force: true });
    }
  });

  it("integrates semantic recall and async ingest with cfMemMiddleware", async () => {
    let ingestedReply = "";
    const memMw = createCfMemMiddleware({
      fetchSemanticContext: async () => "User prefers TypeScript and dark theme.",
      ingestConversationTurn: async (_ctx, reply) => {
        ingestedReply = reply;
      },
    });
    const pipeline = createMiddlewarePipeline([memMw]);

    const enrichedPrompt = await pipeline.executeBeforeInput(baseCtx);
    assert.match(enrichedPrompt, /<recalled_memory>/);
    assert.match(enrichedPrompt, /User prefers TypeScript and dark theme./);

    await pipeline.executeAfterOutput(baseCtx, "I have updated the settings.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ingestedReply, "I have updated the settings.");
  });

  it("handles errors gracefully without crashing pipeline", async () => {
    let caughtError: Error | null = null;
    const errorMw: AdsMiddleware = {
      name: "errorMw",
      onTurnError: (_ctx, err) => {
        caughtError = err;
      },
    };
    const failingMw: AdsMiddleware = {
      name: "failingMw",
      onBeforeInput: () => {
        throw new Error("Unexpected middleware failure");
      },
    };

    const pipeline = createMiddlewarePipeline([failingMw, errorMw]);
    const prompt = await pipeline.executeBeforeInput(baseCtx);
    assert.equal(prompt, "original prompt");

    const testError = new Error("Agent turn crashed");
    await pipeline.executeTurnError(baseCtx, testError);
    assert.equal(caughtError, testError);
  });

  it("wraps a real agent turn with before, start, and after hooks", async () => {
    const calls: string[] = [];
    const pipeline = createMiddlewarePipeline([{
      name: "lifecycle-test",
      onBeforeInput: (ctx) => {
        calls.push(`before:${ctx.prompt}`);
        return { modifiedPrompt: `${ctx.prompt} [prepared]` };
      },
      onTurnStart: (ctx) => calls.push(`start:${ctx.prompt}`),
      onAfterOutput: (_ctx, reply) => calls.push(`after:${reply}`),
      onTurnError: (_ctx, error) => calls.push(`error:${error.message}`),
    }]);
    const orchestrator = {
      getActiveAgentId: () => "codex",
      onEvent: () => () => {},
      invokeAgent: async (_agentId: string, input: unknown) => ({
        response: `reply for ${String(input)}`,
        usage: null,
        agentId: "codex",
      }),
    } as any;

    const result = await runAgentTurn(orchestrator, "original", {
      middleware: pipeline,
      middlewareContext: {
        turnId: "turn-1",
        sessionId: "session-1",
        channel: "web",
      },
      workspaceRoot: os.tmpdir(),
    });

    assert.equal(result.response, "reply for original [prepared]");
    assert.deepEqual(calls, [
      "before:original",
      "start:original [prepared]",
      "after:reply for original [prepared]",
    ]);
  });

  it("fails closed when an item-start middleware throws", async () => {
    const pipeline = createMiddlewarePipeline([{
      name: "broken-guard",
      onItemStart: () => {
        throw new Error("guard unavailable");
      },
    }]);

    const result = await pipeline.executeItemStart(baseCtx, {
      type: "command_execution",
      command: "echo safe",
    });

    assert.equal(result.blockExecution, true);
    assert.match(result.reason ?? "", /failed closed/);
  });
});

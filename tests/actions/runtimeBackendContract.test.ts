import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { LaneDispatchBus } from "../../server/actions/bus.js";
import { CodexAppServerClient } from "../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../server/codex/appServer/daemonRegistry.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";

function createCodexServer(): {
  client: CodexAppServerClient;
  notify: (method: string, params: Record<string, unknown>) => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const client = new CodexAppServerClient();
  client.attach({ stdin, stdout, stderr, waitClose: async () => null });
  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string };
      const result = message.method === "thread/start" ? { thread: { id: "review-thread" } } : {};
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    }
  });
  return {
    client,
    notify: (method, params) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
  };
}

function reviewPayload() {
  return {
    issue: { id: 374, title: "Runtime backend contract" },
    diff: "diff --git a/a.ts b/a.ts\n+ change",
    diffStat: " a.ts | 1 +\n 1 file changed",
    testReport: { command: "npm test", exitCode: 0, summary: "passed" },
  };
}

describe("Actions runtime backend contracts", () => {
  let stateDir: string;
  let workspace: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-backend-state-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-backend-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(stateDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("runs an isolated ephemeral Reviewer with the Native backend", async () => {
    let createdSessions = 0;
    let reviewerUserId: number | undefined;
    const adapter = new NativeAgentAdapter({
      credentialOwner: "review-owner",
      workspaceRoot: workspace,
      modelResolver: {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-key",
          provider: "test",
        }),
      },
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ status: "PASS", summary: "native review", defects: [] }) }, finish_reason: "stop" }],
      }), { headers: { "content-type": "application/json" } }),
    });
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model", undefined, {
      ...process.env,
      ADS_AGENT_RUNTIME: "native",
    }, {
      createSession: ({ userId }) => {
        createdSessions += 1;
        reviewerUserId = userId;
        return new HybridOrchestrator({ adapters: [adapter] });
      },
    });
    const bus = new LaneDispatchBus(getStateDatabase(), { sessionManager });

    const verdict = await bus.executeReviewer(reviewPayload(), workspace, undefined, "history", "project", "job-native");

    assert.equal(verdict.status, "PASS");
    assert.equal(createdSessions, 1);
    assert.ok(reviewerUserId);
    assert.equal(sessionManager.hasSession(reviewerUserId), false);
  });

  it("runs an isolated ephemeral Reviewer with the Codex app-server backend", async () => {
    const server = createCodexServer();
    const registry = new CodexAppServerDaemonRegistry({ factory: () => server.client });
    const adapter = new CodexAppServerAdapter({ projectId: "review-codex", registry });
    let createdSessions = 0;
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model", undefined, {
      ...process.env,
      ADS_AGENT_RUNTIME: "codex-app-server",
    }, {
      createSession: () => {
        createdSessions += 1;
        return new HybridOrchestrator({ adapters: [adapter] });
      },
    });
    const bus = new LaneDispatchBus(getStateDatabase(), { sessionManager });
    const pending = bus.executeReviewer(reviewPayload(), workspace, undefined, "history", "project", "job-codex");
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.notify("thread/started", { thread: { id: "review-thread" } });
    server.notify("turn/started", { threadId: "review-thread", turn: { id: "review-turn" } });
    server.notify("item/completed", {
      item: {
        type: "agentMessage",
        id: "review-message",
        text: JSON.stringify({ status: "PASS", summary: "codex review", defects: [] }),
      },
      threadId: "review-thread",
      turnId: "review-turn",
    });
    server.notify("turn/completed", { threadId: "review-thread", turn: { id: "review-turn" } });

    const verdict = await pending;
    assert.equal(verdict.status, "PASS");
    assert.equal(createdSessions, 1);
    await registry.stopAll();
  });
});

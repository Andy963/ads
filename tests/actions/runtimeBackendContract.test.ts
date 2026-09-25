import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";

import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { LaneDispatchBus } from "../../server/actions/bus.js";
import { CodexAppServerClient } from "../../server/codex/appServer/rpcClient.js";
import { CodexAppServerDaemonRegistry } from "../../server/codex/appServer/daemonRegistry.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { updateActionJobStatus } from "../../server/state/actionJobStore.js";
import { SessionManager } from "../../server/sessions/sessionManager.js";

function createCodexServer(options: {
  threadId?: string;
  onTurnStart?: () => void;
  autoCompleteTurn?: {
    threadId: string;
    turnId: string;
    response: string;
  };
} = {}): {
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
      if (message.method === "turn/start") {
        options.onTurnStart?.();
        if (options.autoCompleteTurn) {
          const { threadId, turnId, response } = options.autoCompleteTurn;
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId } } })}\n`);
          stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              item: { type: "agentMessage", id: "developer-message", text: response },
              threadId,
              turnId,
            },
          })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId } } })}\n`);
        }
      }
      const result = message.method === "thread/start" ? { thread: { id: options.threadId ?? "review-thread" } } : {};
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    }
  });
  return {
    client,
    notify: (method, params) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
  };
}

function nativeSseResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function initializeRepository(repoPath: string): void {
  spawnSync("git", ["init", "-b", "dev"], { cwd: repoPath });
  spawnSync("git", ["config", "user.email", "test@ads.test"], { cwd: repoPath });
  spawnSync("git", ["config", "user.name", "AdsTest"], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Runtime backend contract\n");
  spawnSync("git", ["add", "README.md"], { cwd: repoPath });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });
  spawnSync("git", ["checkout", "-b", "codex/issue-374"], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "implementation.txt"), "implemented by runtime\n");
  spawnSync("git", ["add", "implementation.txt"], { cwd: repoPath });
}

async function waitForJobStatus(
  bus: LaneDispatchBus,
  jobId: string,
  status: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bus.getJob(jobId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for job ${jobId} to reach ${status}`);
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

  it("executes an Actions Developer turn with the Native backend", async () => {
    initializeRepository(workspace);
    let requestCount = 0;
    const adapter = new NativeAgentAdapter({
      credentialOwner: "developer-owner",
      workspaceRoot: workspace,
      workingDirectory: workspace,
      modelResolver: {
        resolve: () => ({
          model: "test-model",
          baseUrl: "https://provider.test/v1",
          apiKey: "test-key",
          provider: "test",
        }),
      },
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return nativeSseResponse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "developer-commit", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "git", args: ["commit", "-m", "implementation"] }) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]);
        }
        return nativeSseResponse([
          { choices: [{ delta: { content: "Native developer completed" }, finish_reason: "stop" }] },
        ]);
      },
    });
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model", undefined, {
      ...process.env,
      ADS_AGENT_RUNTIME: "native",
    }, {
      createSession: ({ cwd, userModel }) => new HybridOrchestrator({
        adapters: [adapter],
        initialWorkingDirectory: cwd,
        initialModel: userModel,
      }),
    });
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db, {
      sessionManager,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "Native developer passed", defects: [] }),
      testCommand: "true",
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });
    const job = bus.dispatchJob({
      projectId: workspace,
      issueId: 374,
      issueTitle: "Native developer execution",
      issueDescription: "Execute a real developer turn.",
      acceptanceCriteria: ["Commit through the Native runtime"],
      repoPath: workspace,
    });
    updateActionJobStatus(db, job.jobId, "running");

    await bus.executeDeveloper(job.jobId, workspace);
    await waitForJobStatus(bus, job.jobId, "completed");

    assert.match(
      spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: workspace, encoding: "utf8" }).stdout,
      /implementation/,
    );
  });

  it("executes an Actions Developer turn with the Codex app-server backend", async () => {
    initializeRepository(workspace);
    let committed = false;
    const server = createCodexServer({
      threadId: "developer-thread",
      onTurnStart: () => {
        if (!committed) {
          committed = true;
          spawnSync("git", ["commit", "-m", "implementation"], { cwd: workspace });
        }
      },
      autoCompleteTurn: {
        threadId: "developer-thread",
        turnId: "developer-turn",
        response: "Codex developer completed",
      },
    });
    const registry = new CodexAppServerDaemonRegistry({ factory: () => server.client });
    const adapter = new CodexAppServerAdapter({
      projectId: "developer-codex",
      workingDirectory: workspace,
      registry,
    });
    const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model", undefined, {
      ...process.env,
      ADS_AGENT_RUNTIME: "codex-app-server",
    }, {
      createSession: ({ cwd, userModel }) => new HybridOrchestrator({
        adapters: [adapter],
        initialWorkingDirectory: cwd,
        initialModel: userModel,
      }),
    });
    const db = getStateDatabase();
    const bus = new LaneDispatchBus(db, {
      sessionManager,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "Codex developer passed", defects: [] }),
      testCommand: "true",
      hasRemoteOrigin: () => false,
      mergePipeline: () => ({ success: true }),
    });
    const job = bus.dispatchJob({
      projectId: workspace,
      issueId: 374,
      issueTitle: "Codex developer execution",
      issueDescription: "Execute a real developer turn.",
      acceptanceCriteria: ["Commit through the Codex app-server runtime"],
      repoPath: workspace,
    });
    updateActionJobStatus(db, job.jobId, "running");

    await bus.executeDeveloper(job.jobId, workspace);
    await waitForJobStatus(bus, job.jobId, "completed");

    assert.equal(committed, true);
    assert.match(
      spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: workspace, encoding: "utf8" }).stdout,
      /implementation/,
    );
    await registry.stopAll();
  });
});

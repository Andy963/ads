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
  supervised?: boolean;
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
  const emitFinal = () => {
    const { threadId, turnId, response } = options.autoCompleteTurn!;
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", id: "final", text: response }, threadId, turnId } })}\n`);
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId } } })}\n`);
  };
  const requestTool = (tool: string) => {
    const { threadId, turnId } = options.autoCompleteTurn!;
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: tool, method: "item/tool/call", params: { threadId, turnId, callId: tool, tool, arguments: {} } })}\n`);
  };
  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number | string; method?: string; result?: { success?: boolean } };
      if (options.supervised && !message.method) {
        assert.equal(message.result?.success, true);
        if (message.id === "review_action") requestTool("deliver_action");
        else emitFinal();
        continue;
      }
      if (message.method === "turn/start") {
        options.onTurnStart?.();
        if (options.autoCompleteTurn) {
          const { threadId, turnId } = options.autoCompleteTurn;
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId } } })}\n`);
          if (options.supervised) queueMicrotask(() => requestTool("review_action"));
          else emitFinal();
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

  for (const backend of ["native", "codex-app-server"]) {
    it(`isolates Reviewer tools from the ${backend} session backend`, async () => {
      initializeRepository(workspace);
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
      const sessionManager = new SessionManager(0, 0, "workspace-write", "test-model", undefined, {
        ...process.env, ADS_AGENT_RUNTIME: backend,
      }, {
        createSession: () => { throw new Error("Reviewer must not create a general-purpose session"); },
      });
      let requests = 0;
      const bus = new LaneDispatchBus(getStateDatabase(), {
        sessionManager,
        reviewerModelResolver: () => ({ model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test" }),
        reviewerComplete: async (request) => {
          requests++;
          assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["read_diff", "read_file_range", "search_code", "list_dir"]);
          return { text: JSON.stringify({ status: "PASS", summary: "isolated review", defects: [] }), toolCalls: [] };
        },
      });
      const verdict = await bus.executeReviewer({
        ...reviewPayload(),
        diffRange: { range: "dev...HEAD", baseRef: "dev", headRef: "HEAD", baseCommit: head, headCommit: head },
      }, workspace);
      assert.equal(verdict.status, "PASS");
      assert.equal(requests, 1);
    });
  }

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
      fetchImpl: async (_input, init) => {
        requestCount += 1;
        const body = JSON.parse(String(init?.body));
        if (requestCount > 2 && requestCount < 6) {
          const results = body.messages.filter((m: { role: string }) => m.role === "tool");
          assert.ok(results.length > 0);
        }
        if (requestCount === 2 || requestCount === 3 || requestCount === 4) {
          const tool = requestCount === 2 ? "review_action" : "deliver_action";
          return nativeSseResponse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `supervision-${requestCount}`, type: "function", function: { name: tool, arguments: "{}" } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]);
        }
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
    let deliveries = 0;
    let creates = 0;
    let reviewedHead = "";
    const bus = new LaneDispatchBus(db, {
      sessionManager,
      reviewerRunner: async () => JSON.stringify({ status: "PASS", summary: "Native developer passed", defects: [] }),
      testCommand: "true",
      hasRemoteOrigin: () => true,
      pullRequestCreator: () => { creates++; return { prNumber: 42, prUrl: "https://github.test/pull/42" }; },
      pullRequestStateReader: () => ({ state: "MERGED", merged: true, mergedAt: 1, baseRefName: "dev", headRefOid: reviewedHead }),
      mergePipeline: ({ prNumber, expectedHead }) => {
        assert.equal(prNumber, 42);
        assert.ok(expectedHead);
        reviewedHead = expectedHead!;
        if (++deliveries === 1) {
          spawnSync("git", ["checkout", "dev"], { cwd: workspace });
          spawnSync("git", ["merge", "--ff-only", "codex/issue-374"], { cwd: workspace });
          spawnSync("git", ["branch", "-d", "codex/issue-374"], { cwd: workspace });
          return { success: false, error: "Merged, but issue close failed" };
        }
        return { success: true };
      },
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
    assert.equal(deliveries, 2);
    assert.equal(creates, 1);
    assert.equal(requestCount, 5);
    assert.equal(bus.getJob(job.jobId)?.rework_count, 0);

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
      supervised: true,
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

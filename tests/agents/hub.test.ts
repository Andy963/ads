import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { Input } from "@openai/codex-sdk";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";
import { runCollaborativeTurn } from "../../src/agents/hub.js";
import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

class QueueAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly queue: string[];

  constructor(options: { id: string; name: string; queue: string[] }) {
    this.id = options.id;
    this.queue = [...options.queue];
    this.metadata = {
      id: options.id,
      name: options.name,
      vendor: "test",
      capabilities: ["text"],
    };
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: false, throttleMs: 0 };
  }

  status() {
    return { ready: true, streaming: false };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    void handler;
    return () => undefined;
  }

  reset(): void {
    // stateless
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    void input;
    void options;
    const response = this.queue.shift() ?? "(no response)";
    return { response, usage: null, agentId: this.id };
  }
}

describe("agents/hub", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let tmpDir: string | null = null;
  let adsState: TempAdsStateDir | null = null;

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    resetStateDatabaseForTests();
    originalEnv.ENABLE_AGENT_FILE_TOOLS = process.env.ENABLE_AGENT_FILE_TOOLS;
    originalEnv.ADS_STATE_DB_PATH = process.env.ADS_STATE_DB_PATH;
    originalEnv.ADS_COORDINATOR_ENABLED = process.env.ADS_COORDINATOR_ENABLED;
    setEnv("ENABLE_AGENT_FILE_TOOLS", "1");
    setEnv("ADS_STATE_DB_PATH", ":memory:");
    setEnv("ADS_COORDINATOR_ENABLED", "1");
    adsState = installTempAdsStateDir("ads-state-hub-");

    const scratchRoot = path.join(process.cwd(), ".ads-test-tmp");
    fs.mkdirSync(scratchRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(scratchRoot, "agent-hub-"));
  });

  afterEach(() => {
    setEnv("ENABLE_AGENT_FILE_TOOLS", originalEnv.ENABLE_AGENT_FILE_TOOLS);
    setEnv("ADS_STATE_DB_PATH", originalEnv.ADS_STATE_DB_PATH);
    setEnv("ADS_COORDINATOR_ENABLED", originalEnv.ADS_COORDINATOR_ENABLED);
    adsState?.restore();
    adsState = null;
    resetStateDatabaseForTests();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("runs tool loop for non-codex main agent", async () => {
    assert.ok(tmpDir);
    const adapter = new QueueAgentAdapter({
      id: "gemini",
      name: "Gemini",
      queue: [
        [
          "I will write a file.",
          "<<<tool.write",
          '{"path":"hello.txt","content":"hi"}',
          ">>>",
        ].join("\n"),
        "done",
      ],
    });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "gemini",
      initialWorkingDirectory: tmpDir,
    });

    const result = await runCollaborativeTurn(orchestrator, "test", {
      maxSupervisorRounds: 0,
      maxToolRounds: 2,
      toolContext: { cwd: tmpDir, allowedDirs: [tmpDir] },
    });

    assert.equal(result.response, "done");
    assert.equal(fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf8"), "hi");
  });

  it("supports delegation when main agent is not codex", async () => {
    assert.ok(tmpDir);
    const supervisor = new QueueAgentAdapter({
      id: "gemini",
      name: "Gemini",
      queue: [
        [
          "Need help from codex.",
          "<<<agent.codex",
          "Say hello",
          ">>>",
        ].join("\n"),
        "supervisor done",
      ],
    });
    const delegate = new QueueAgentAdapter({
      id: "codex",
      name: "Codex",
      queue: ["hello from codex"],
    });
    const orchestrator = new HybridOrchestrator({
      adapters: [supervisor, delegate],
      defaultAgentId: "gemini",
      initialWorkingDirectory: tmpDir,
    });

    const result = await runCollaborativeTurn(orchestrator, "test", {
      maxSupervisorRounds: 1,
      maxDelegations: 2,
      maxToolRounds: 0,
      toolContext: { cwd: tmpDir, allowedDirs: [tmpDir] },
    });

    assert.equal(result.response, "supervisor done");
    assert.equal(result.delegations.length, 1);
    assert.equal(result.delegations[0]?.agentId, "codex");
    assert.equal(result.delegations[0]?.response, "hello from codex");
  });

  it("runs tool loop for Claude", async () => {
    assert.ok(tmpDir);
    const adapter = new QueueAgentAdapter({
      id: "claude",
      name: "Claude",
      queue: [
        [
          "Attempt tool call.",
          "<<<tool.write",
          '{"path":"ignored.txt","content":"nope"}',
          ">>>",
        ].join("\n"),
        "done",
      ],
    });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "claude",
      initialWorkingDirectory: tmpDir,
    });

    const result = await runCollaborativeTurn(orchestrator, "test", {
      maxSupervisorRounds: 0,
      maxToolRounds: 2,
      toolContext: { cwd: tmpDir, allowedDirs: [tmpDir] },
    });

    assert.equal(result.response, "done");
    assert.equal(fs.existsSync(path.join(tmpDir, "ignored.txt")), true);
  });

  it("retries coordinator final prompt if supervisor returns verdict JSON", async () => {
    assert.ok(tmpDir);

    const verdictJson = [
      "```json",
      JSON.stringify({ verdicts: [] }, null, 2),
      "```",
    ].join("\n");

    const codex = new QueueAgentAdapter({
      id: "codex",
      name: "Codex",
      queue: [verdictJson, verdictJson, "final answer"],
    });
    const helper = new QueueAgentAdapter({
      id: "gemini",
      name: "Gemini",
      queue: ["(unused)"],
    });

    const orchestrator = new HybridOrchestrator({
      adapters: [codex, helper],
      defaultAgentId: "codex",
      initialWorkingDirectory: tmpDir,
    });

    const result = await runCollaborativeTurn(orchestrator, "test", {
      maxSupervisorRounds: 0,
      maxToolRounds: 0,
      toolContext: { cwd: tmpDir, allowedDirs: [tmpDir], historyNamespace: "test", historySessionId: "hub" },
    });

    assert.equal(result.response, "final answer");
    assert.equal(result.delegations.length, 0);
    assert.equal(result.supervisorRounds, 0);
  });

  it("does not emit vector auto-context explored entry when there is no hit", async () => {
    assert.ok(tmpDir);

    const originalFetch = globalThis.fetch;
    const originalEnv = {
      ADS_VECTOR_SEARCH_ENABLED: process.env.ADS_VECTOR_SEARCH_ENABLED,
      ADS_VECTOR_SEARCH_URL: process.env.ADS_VECTOR_SEARCH_URL,
      ADS_VECTOR_SEARCH_TOKEN: process.env.ADS_VECTOR_SEARCH_TOKEN,
      ADS_VECTOR_SEARCH_TIMEOUT_MS: process.env.ADS_VECTOR_SEARCH_TIMEOUT_MS,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS,
    };

    const setEnvLocal = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    try {
      setEnvLocal("ADS_VECTOR_SEARCH_ENABLED", "1");
      setEnvLocal("ADS_VECTOR_SEARCH_URL", "http://vector.local");
      setEnvLocal("ADS_VECTOR_SEARCH_TOKEN", "test-token");
      setEnvLocal("ADS_VECTOR_SEARCH_TIMEOUT_MS", "50");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", "1");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE", "always");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", "0");

      globalThis.fetch = async (url, options) => {
        const target = String(url);
        const request = (options ?? {}) as RequestInit;
        const method = String(request.method ?? "GET").toUpperCase();
        const pathname = new URL(target).pathname;

        if (pathname === "/health" && method === "GET") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/upsert" && method === "POST") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/query" && method === "POST") {
          return new Response(JSON.stringify({ hits: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const adapter = new QueueAgentAdapter({ id: "codex", name: "Codex", queue: ["done"] });
      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        defaultAgentId: "codex",
        initialWorkingDirectory: tmpDir,
      });

      const explored: Array<{ category: string; summary: string }> = [];
      const result = await runCollaborativeTurn(orchestrator, "hello", {
        maxSupervisorRounds: 0,
        maxToolRounds: 1,
        toolContext: { cwd: tmpDir, allowedDirs: [tmpDir], historyNamespace: "web", historySessionId: "s-1" },
        onExploredEntry: (entry) => explored.push({ category: entry.category, summary: entry.summary }),
      });

      assert.equal(result.response, "done");
      assert.equal(explored.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
      setEnvLocal("ADS_VECTOR_SEARCH_ENABLED", originalEnv.ADS_VECTOR_SEARCH_ENABLED);
      setEnvLocal("ADS_VECTOR_SEARCH_URL", originalEnv.ADS_VECTOR_SEARCH_URL);
      setEnvLocal("ADS_VECTOR_SEARCH_TOKEN", originalEnv.ADS_VECTOR_SEARCH_TOKEN);
      setEnvLocal("ADS_VECTOR_SEARCH_TIMEOUT_MS", originalEnv.ADS_VECTOR_SEARCH_TIMEOUT_MS);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS);
    }
  });

  it("emits a single vector auto-context explored entry when context is injected", async () => {
    assert.ok(tmpDir);

    const originalFetch = globalThis.fetch;
    const originalEnv = {
      ADS_VECTOR_SEARCH_ENABLED: process.env.ADS_VECTOR_SEARCH_ENABLED,
      ADS_VECTOR_SEARCH_URL: process.env.ADS_VECTOR_SEARCH_URL,
      ADS_VECTOR_SEARCH_TOKEN: process.env.ADS_VECTOR_SEARCH_TOKEN,
      ADS_VECTOR_SEARCH_TIMEOUT_MS: process.env.ADS_VECTOR_SEARCH_TIMEOUT_MS,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS,
      ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE: process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE,
    };

    const setEnvLocal = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    try {
      setEnvLocal("ADS_VECTOR_SEARCH_ENABLED", "1");
      setEnvLocal("ADS_VECTOR_SEARCH_URL", "http://vector.local");
      setEnvLocal("ADS_VECTOR_SEARCH_TOKEN", "test-token");
      setEnvLocal("ADS_VECTOR_SEARCH_TIMEOUT_MS", "50");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", "1");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE", "always");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", "0");
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE", "0.01");

      globalThis.fetch = async (url, options) => {
        const target = String(url);
        const request = (options ?? {}) as RequestInit;
        const method = String(request.method ?? "GET").toUpperCase();
        const pathname = new URL(target).pathname;

        if (pathname === "/health" && method === "GET") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/upsert" && method === "POST") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/query" && method === "POST") {
          return new Response(
            JSON.stringify({
              hits: [
                {
                  id: "h-1",
                  score: 0.9,
                  metadata: { source_type: "chat", namespace: "web", role: "ai" },
                  snippet: "test snippet",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      };

      const adapter = new QueueAgentAdapter({ id: "codex", name: "Codex", queue: ["done"] });
      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        defaultAgentId: "codex",
        initialWorkingDirectory: tmpDir,
      });

      const explored: Array<{ category: string; summary: string }> = [];
      const result = await runCollaborativeTurn(orchestrator, "hello", {
        maxSupervisorRounds: 0,
        maxToolRounds: 1,
        toolContext: { cwd: tmpDir, allowedDirs: [tmpDir], historyNamespace: "web", historySessionId: "s-1" },
        onExploredEntry: (entry) => explored.push({ category: entry.category, summary: entry.summary }),
      });

      assert.equal(result.response, "done");
      assert.equal(explored.length, 1);
      assert.equal(explored[0]!.category, "Search");
      assert.ok(explored[0]!.summary.includes("VectorSearch(auto)"));
      assert.ok(explored[0]!.summary.includes("injected=1"));
    } finally {
      globalThis.fetch = originalFetch;
      setEnvLocal("ADS_VECTOR_SEARCH_ENABLED", originalEnv.ADS_VECTOR_SEARCH_ENABLED);
      setEnvLocal("ADS_VECTOR_SEARCH_URL", originalEnv.ADS_VECTOR_SEARCH_URL);
      setEnvLocal("ADS_VECTOR_SEARCH_TOKEN", originalEnv.ADS_VECTOR_SEARCH_TOKEN);
      setEnvLocal("ADS_VECTOR_SEARCH_TIMEOUT_MS", originalEnv.ADS_VECTOR_SEARCH_TIMEOUT_MS);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS);
      setEnvLocal("ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE", originalEnv.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE);
    }
  });
});

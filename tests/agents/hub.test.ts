import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { Input } from "@openai/codex-sdk";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";
import { runCollaborativeTurn } from "../../src/agents/hub.js";

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

  async send(_input: Input, _options?: AgentSendOptions): Promise<AgentRunResult> {
    const response = this.queue.shift() ?? "(no response)";
    return { response, usage: null, agentId: this.id };
  }
}

describe("agents/hub", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let tmpDir: string | null = null;

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  beforeEach(() => {
    originalEnv.ENABLE_AGENT_FILE_TOOLS = process.env.ENABLE_AGENT_FILE_TOOLS;
    setEnv("ENABLE_AGENT_FILE_TOOLS", "1");

    const scratchRoot = path.join(process.cwd(), ".ads-test-tmp");
    fs.mkdirSync(scratchRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(scratchRoot, "agent-hub-"));
  });

  afterEach(() => {
    setEnv("ENABLE_AGENT_FILE_TOOLS", originalEnv.ENABLE_AGENT_FILE_TOOLS);
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
});


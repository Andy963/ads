import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Input } from "../../src/agents/protocol/types.js";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";
import { listPreferences } from "../../src/memory/soul.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

class CaptureAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  lastInput: Input | null = null;
  calls = 0;
  private readonly fixedResponse: string;

  constructor(options: { id: string; name: string; fixedResponse?: string }) {
    this.id = options.id;
    this.fixedResponse = options.fixedResponse ?? "ok";
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

  onEvent(): () => void {
    return () => undefined;
  }

  reset(): void {
    this.lastInput = null;
    this.calls = 0;
  }

  async send(input: Input, _options?: AgentSendOptions): Promise<AgentRunResult> {
    this.calls += 1;
    this.lastInput = input;
    return { response: this.fixedResponse, usage: null, agentId: this.id };
  }
}

describe("orchestrator preference directives", () => {
  let adsState: TempAdsStateDir | null = null;
  let workspaceRoot: string;
  let workspaceSubdir: string;

  beforeEach(() => {
    adsState = installTempAdsStateDir("ads-state-pref-flow-");
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-flow-"));
    fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
    workspaceSubdir = path.join(workspaceRoot, "subdir");
    fs.mkdirSync(workspaceSubdir, { recursive: true });
  });

  afterEach(() => {
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("saves preference directives and strips them before sending to agent", async () => {
    const adapter = new CaptureAgentAdapter({ id: "codex", name: "Codex", fixedResponse: "done" });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspaceSubdir,
    });

    const result = await orchestrator.send(["记住偏好: theme=dark", "hello"].join("\n"));

    assert.equal(adapter.calls, 1);
    assert.equal(adapter.lastInput, "hello");

    const prefs = listPreferences(workspaceRoot);
    assert.deepEqual(prefs, [{ key: "theme", value: "dark" }]);
    assert.ok(result.response.includes("已保存偏好"), "expected preference suffix in response");
  });

  it("short-circuits agent call when message only contains preference directives", async () => {
    const adapter = new CaptureAgentAdapter({ id: "codex", name: "Codex", fixedResponse: "done" });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspaceSubdir,
    });

    const result = await orchestrator.send("记住偏好: theme=dark");

    assert.equal(adapter.calls, 0);
    assert.equal(adapter.lastInput, null);
    assert.ok(result.response.includes("theme=dark"));
  });
});


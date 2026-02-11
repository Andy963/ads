import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Input } from "../../src/agents/protocol/types.js";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";
import { SystemPromptManager } from "../../src/systemPrompt/manager.js";
import { validateSkillDirectory } from "../../src/skills/creator.js";

class CaptureAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  lastInput: Input | null = null;
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
  }

  async send(input: Input, _options?: AgentSendOptions): Promise<AgentRunResult> {
    this.lastInput = input;
    return { response: this.fixedResponse, usage: null, agentId: this.id };
  }
}

describe("skills auto-load and auto-save", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-flow-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("auto-loads matching skill bodies without explicit $skill reference", async () => {
    const skillDir = path.join(workspace, ".agent", "skills", "kube-helper");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: kube-helper",
        "description: \"Kubernetes debugging helper\"",
        "---",
        "",
        "# Kube Helper",
        "",
        "MY_SKILL_MARKER",
      ].join("\n"),
      "utf8",
    );

    const manager = new SystemPromptManager({ workspaceRoot: workspace, reinjection: { enabled: true, turns: 999, rulesTurns: 999 } });
    const adapter = new CaptureAgentAdapter({ id: "codex", name: "Codex" });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspace,
      systemPromptManager: manager,
    });

    await orchestrator.send("Need help with kubernetes debugging today.");
    assert.equal(typeof adapter.lastInput, "string");
    const prompt = String(adapter.lastInput);
    assert.ok(prompt.includes("<requested_skills>"));
    assert.ok(prompt.includes("MY_SKILL_MARKER"));
  });

  it("auto-saves <skill_save> blocks into .agent/skills and strips them from response", async () => {
    const response = [
      "Hello.",
      "",
      "<skill_save name=\"my-skill\" description=\"One sentence\">",
      "## Overview",
      "",
      "Saved content.",
      "</skill_save>",
      "",
      "Done.",
    ].join("\n");

    const adapter = new CaptureAgentAdapter({ id: "codex", name: "Codex", fixedResponse: response });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspace,
    });

    const result = await orchestrator.send("hi");
    assert.ok(!result.response.includes("<skill_save"));

    const savedDir = path.join(workspace, ".agent", "skills", "my-skill");
    const validated = validateSkillDirectory(savedDir);
    assert.equal(validated.valid, true, validated.message);
    assert.ok(fs.readFileSync(path.join(savedDir, "SKILL.md"), "utf8").includes("name: my-skill"));
  });
});


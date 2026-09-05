import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Input } from "../../server/agents/protocol/types.js";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../server/agents/types.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { SystemPromptManager } from "../../server/systemPrompt/manager.js";
import { validateSkillDirectory } from "../../server/skills/creator.js";

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
  let adsStateDir: string;
  let codexHomeDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-flow-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-flow-state-"));
    codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-flow-codex-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    process.env.CODEX_HOME = codexHomeDir;
    process.env.ADS_MIGRATE_LEGACY_SKILLS = "0";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it("auto-loads matching skill bodies without explicit $skill reference", async () => {
    const skillDir = path.join(codexHomeDir, "skills", "kube-helper");
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

    const manager = new SystemPromptManager({ workspaceRoot: workspace, reinjection: { enabled: true, turns: 999 } });
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
    assert.ok(prompt.includes(`location="${path.join(skillDir, "SKILL.md")}"`));
  });

  it("injects the concrete available skill list into the system prompt", async () => {
    const skillDir = path.join(codexHomeDir, "skills", "subtitle-helper");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: subtitle-helper",
        "description: \"Subtitle helper visible in compact skill list\"",
        "---",
        "",
        "# Subtitle Helper",
      ].join("\n"),
      "utf8",
    );

    const manager = new SystemPromptManager({ workspaceRoot: workspace, reinjection: { enabled: true, turns: 999 } });
    const adapter = new CaptureAgentAdapter({ id: "codex", name: "Codex" });
    const orchestrator = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspace,
      systemPromptManager: manager,
    });

    await orchestrator.send("Which skills are available?");
    assert.equal(typeof adapter.lastInput, "string");
    const prompt = String(adapter.lastInput);
    assert.ok(prompt.includes("<available_skills>"));
    assert.ok(prompt.includes('name="subtitle-helper"'));
    assert.ok(prompt.includes("Subtitle helper visible in compact skill list"));
  });

  it("auto-saves <skill_save> blocks into Codex global skills and strips them from response", async () => {
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

    const savedDir = path.join(codexHomeDir, "skills", "my-skill");
    const validated = validateSkillDirectory(savedDir);
    assert.equal(validated.valid, true, validated.message);
    assert.ok(fs.readFileSync(path.join(savedDir, "SKILL.md"), "utf8").includes("name: my-skill"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Input } from "../../src/agents/protocol/types.js";
import type { AgentEvent } from "../../src/codex/events.js";
import type { AgentAdapter, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";

class FakeSystemPromptManager {
  requestedSkills: string[] = [];

  setRequestedSkills(names: string[]): void {
    this.requestedSkills = names;
  }

  maybeInject(): null {
    return null;
  }

  completeTurn(): void {
    // noop
  }

  setWorkspaceRoot(): void {
    // noop
  }
}

class DummyAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly metadata = {
    id: "codex",
    name: "Dummy",
    vendor: "tests",
    capabilities: ["text"] as const,
  };

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: false, throttleMs: 0 };
  }

  status() {
    return { ready: true, streaming: false };
  }

  async send(_input: Input, _options?: AgentSendOptions): Promise<AgentRunResult> {
    return { response: "ok", usage: null, agentId: this.id };
  }

  onEvent(_handler: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }

  reset(): void {
    // noop
  }
}

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-cjk-"));
}

function writeSkill(workspaceRoot: string, name: string, description: string): void {
  const skillDir = path.join(workspaceRoot, ".agent", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  const content = ["---", `name: ${name}`, `description: "${description}"`, "---", "", `# ${name}`, ""].join("\n");
  fs.writeFileSync(skillFile, content, "utf8");
}

describe("agents/orchestrator skill autoload (CJK)", () => {
  it("infers requested skills from CJK keywords", async () => {
    const workspaceRoot = makeTempWorkspace();
    writeSkill(workspaceRoot, "spec-wizard", "猫咪需求生成spec");
    writeSkill(workspaceRoot, "spec-to-task", "猫咪转换成任务");

    const manager = new FakeSystemPromptManager();
    const orchestrator = new HybridOrchestrator({
      adapters: [new DummyAdapter()],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspaceRoot,
      systemPromptManager: manager as never,
    });
    orchestrator.setWorkingDirectory(workspaceRoot);

    await orchestrator.invokeAgent("codex", "我想要猫咪需求生成spec然后猫咪转换成任务");

    const requested = manager.requestedSkills.map((s) => s.toLowerCase()).sort();
    assert.deepEqual(requested, ["spec-to-task", "spec-wizard"].sort());
  });
});

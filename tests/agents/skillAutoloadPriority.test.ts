import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Input } from "../../src/agents/protocol/types.js";
import type { AgentEvent } from "../../src/codex/events.js";
import type { AgentAdapter, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

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

let adsState: TempAdsStateDir;
let workspaceRoot: string;

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".agent", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const skillFile = path.join(dir, "SKILL.md");
  const content = ["---", `name: ${name}`, `description: "${description}"`, "---", "", `# ${name}`, ""].join("\n");
  fs.writeFileSync(skillFile, content, "utf8");
}

function writeRegistryMetadata(stateDir: string, yamlBody: string): void {
  const dir = path.join(stateDir, ".agent", "skills");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.yaml"), yamlBody, "utf8");
}

describe("skills autoload priority registry", () => {
  beforeEach(() => {
    adsState = installTempAdsStateDir("ads-state-skill-registry-");
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-registry-workspace-"));
  });

  afterEach(() => {
    adsState.restore();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("dedupes same provides group and picks higher priority skill", async () => {
    writeSkill(workspaceRoot, "demo-skill-a", "priodemoalpha priodemobeta priodemogamma");
    writeSkill(workspaceRoot, "demo-skill-b", "priodemoalpha priodemobeta");

    writeRegistryMetadata(adsState.stateDir, [
      "version: 1",
      "mode: overlay",
      "skills:",
      "  demo-skill-a:",
      "    provides: [demo]",
      "    priority: 1",
      "  demo-skill-b:",
      "    provides: [demo]",
      "    priority: 100",
      "",
    ].join("\n"));

    const manager = new FakeSystemPromptManager();
    const orchestrator = new HybridOrchestrator({
      adapters: [new DummyAdapter()],
      defaultAgentId: "codex",
      initialWorkingDirectory: workspaceRoot,
      systemPromptManager: manager as never,
    });
    orchestrator.setWorkingDirectory(workspaceRoot);

    await orchestrator.invokeAgent("codex", "please priodemoalpha priodemobeta priodemogamma");

    const requested = manager.requestedSkills.map((s) => s.toLowerCase()).sort();
    assert.deepEqual(requested, ["demo-skill-b"]);
  });
});

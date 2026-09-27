import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Input } from "../../server/agents/protocol/types.js";
import type { AgentEvent } from "../../server/codex/events.js";

import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../server/agents/types.js";
import { HybridOrchestrator } from "../../server/agents/orchestrator.js";
import { SystemPromptManager } from "../../server/systemPrompt/manager.js";
import { validateSkillDirectory } from "../../server/skills/creator.js";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class FakeSystemPromptManager {
  turns = 0;

  setWorkspaceRoot(): void {
    // no-op
  }

  maybeInject(): null {
    return null;
  }

  completeTurn(): void {
    this.turns += 1;
  }
}

class InjectingSystemPromptManager {
  setWorkspaceRoot(): void {
    // no-op
  }

  maybeInject(): { text: string; reason: string; instructionsHash: string } {
    return { text: "INJECTED_SYSTEM", reason: "test", instructionsHash: "x" };
  }

  completeTurn(): void {
    // no-op
  }
}

class DeferredAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly deferred: Deferred<void>;

  constructor(options: { id: string; name: string; deferred: Deferred<void> }) {
    this.id = options.id;
    this.deferred = options.deferred;
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
    await this.deferred.promise;
    return { response: "ok", usage: null, agentId: this.id };
  }
}

class CaptureAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  lastInput: Input | null = null;

  constructor(options: { id: string; name: string }) {
    this.id = options.id;
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

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    void handler;
    return () => undefined;
  }

  reset(): void {
    this.lastInput = null;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    void options;
    this.lastInput = input;
    return { response: "ok", usage: null, agentId: this.id };
  }
}

describe("agents/orchestrator", () => {
  it("injects system prompt into codex inputs", async () => {
    const manager = new InjectingSystemPromptManager();
    const codex = new CaptureAgentAdapter({ id: "codex", name: "Codex" });
    const orchestrator = new HybridOrchestrator({
      adapters: [codex],
      defaultAgentId: "codex",
      systemPromptManager: manager,
    });

    await orchestrator.send("hi");
    assert.equal(typeof codex.lastInput, "string");
    assert.ok(String(codex.lastInput).includes("INJECTED_SYSTEM"));
    assert.ok(String(codex.lastInput).includes("用户请求"));
  });

  it("does not lose non-codex completeTurn when switching active agent mid-send", async () => {
    const manager = new FakeSystemPromptManager();
    const gate = createDeferred<void>();
    const gemini = new DeferredAgentAdapter({ id: "gemini", name: "Gemini", deferred: gate });
    const codex = new DeferredAgentAdapter({ id: "codex", name: "Codex", deferred: createDeferred<void>() });
    const orchestrator = new HybridOrchestrator({
      adapters: [gemini, codex],
      defaultAgentId: "gemini",
      systemPromptManager: manager,
    });

    const pending = orchestrator.send("hi");
    orchestrator.switchAgent("codex");
    gate.resolve();
    await pending;

    assert.equal(manager.turns, 1);
  });

  it("calls completeTurn for codex sends even when switching to non-codex mid-send", async () => {
    const manager = new FakeSystemPromptManager();
    const gate = createDeferred<void>();
    const codex = new DeferredAgentAdapter({ id: "codex", name: "Codex", deferred: gate });
    const gemini = new DeferredAgentAdapter({ id: "gemini", name: "Gemini", deferred: createDeferred<void>() });
    const orchestrator = new HybridOrchestrator({
      adapters: [codex, gemini],
      defaultAgentId: "codex",
      systemPromptManager: manager,
    });

    const pending = orchestrator.send("hi");
    orchestrator.switchAgent("gemini");
    gate.resolve();
    await pending;

    assert.equal(manager.turns, 1);
  });
});

class SkillTrackingSystemPromptManager {
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

class FlowCaptureAgentAdapter implements AgentAdapter {
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

describe("agents/orchestrator skills", () => {
  let workspaceRoot: string;
  let adsStateDir: string;
  let codexHomeDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-workspace-"));
    adsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-state-"));
    codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-skill-codex-"));
    process.env.ADS_STATE_DIR = adsStateDir;
    process.env.CODEX_HOME = codexHomeDir;
    process.env.ADS_MIGRATE_LEGACY_SKILLS = "0";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(adsStateDir, { recursive: true, force: true });
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string, description: string): void {
    const dir = path.join(root, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    const skillFile = path.join(dir, "SKILL.md");
    const content = ["---", `name: ${name}`, `description: "${description}"`, "---", "", `# ${name}`, ""].join("\n");
    fs.writeFileSync(skillFile, content, "utf8");
  }

  function writeRegistryMetadata(root: string, yamlBody: string): void {
    const dir = path.join(root, "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metadata.yaml"), yamlBody, "utf8");
  }

  describe("skill autoload keyword inference", () => {
    it("infers requested skills from CJK keywords", async () => {
      writeSkill(codexHomeDir, "cat-requirements", "猫咪需求分析");
      writeSkill(codexHomeDir, "cat-task", "猫咪转换成任务");

      const manager = new SkillTrackingSystemPromptManager();
      const orchestrator = new HybridOrchestrator({
        adapters: [new DummyAdapter()],
        defaultAgentId: "codex",
        initialWorkingDirectory: workspaceRoot,
        systemPromptManager: manager as never,
      });
      orchestrator.setWorkingDirectory(workspaceRoot);

      await orchestrator.invokeAgent("codex", "我想要猫咪需求分析然后猫咪转换成任务");

      const requested = manager.requestedSkills.map((s) => s.toLowerCase()).sort();
      assert.deepEqual(requested, ["cat-requirements", "cat-task"].sort());
    });

    it("dedupes same provides group and picks higher priority skill", async () => {
      writeSkill(codexHomeDir, "demo-skill-a", "priodemoalpha priodemobeta priodemogamma");
      writeSkill(codexHomeDir, "demo-skill-b", "priodemoalpha priodemobeta");

      writeRegistryMetadata(codexHomeDir, [
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

      const manager = new SkillTrackingSystemPromptManager();
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

  describe("skills auto-load and auto-save", () => {
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

      const manager = new SystemPromptManager({ workspaceRoot, reinjection: { enabled: true, turns: 999 } });
      const adapter = new FlowCaptureAgentAdapter({ id: "codex", name: "Codex" });
      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        defaultAgentId: "codex",
        initialWorkingDirectory: workspaceRoot,
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

      const manager = new SystemPromptManager({ workspaceRoot, reinjection: { enabled: true, turns: 999 } });
      const adapter = new FlowCaptureAgentAdapter({ id: "codex", name: "Codex" });
      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        defaultAgentId: "codex",
        initialWorkingDirectory: workspaceRoot,
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

      const adapter = new FlowCaptureAgentAdapter({ id: "codex", name: "Codex", fixedResponse: response });
      const orchestrator = new HybridOrchestrator({
        adapters: [adapter],
        defaultAgentId: "codex",
        initialWorkingDirectory: workspaceRoot,
      });

      const result = await orchestrator.send("hi");
      assert.ok(!result.response.includes("<skill_save"));

      const savedDir = path.join(codexHomeDir, "skills", "my-skill");
      const validated = validateSkillDirectory(savedDir);
      assert.equal(validated.valid, true, validated.message);
      assert.ok(fs.readFileSync(path.join(savedDir, "SKILL.md"), "utf8").includes("name: my-skill"));
    });
  });
});

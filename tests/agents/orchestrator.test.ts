import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Input } from "../../src/agents/protocol/types.js";

import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../../src/agents/types.js";
import { HybridOrchestrator } from "../../src/agents/orchestrator.js";

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
    await this.deferred.promise;
    return { response: "ok", usage: null, agentId: this.id };
  }
}

describe("agents/orchestrator", () => {
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

  it("does not call completeTurn for codex sends even when switching to non-codex mid-send", async () => {
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

    assert.equal(manager.turns, 0);
  });
});

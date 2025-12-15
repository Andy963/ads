import type { Input } from "@openai/codex-sdk";
import type {
  AgentAdapter,
  AgentIdentifier,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "./types.js";
import type { SystemPromptManager } from "../systemPrompt/manager.js";

interface AgentEntry {
  adapter: AgentAdapter;
  metadata: AgentMetadata;
}

export interface HybridOrchestratorOptions {
  adapters: AgentAdapter[];
  defaultAgentId?: AgentIdentifier;
  initialWorkingDirectory?: string;
  initialModel?: string;
  systemPromptManager?: SystemPromptManager;
}

export interface AgentDescriptor {
  metadata: AgentMetadata;
  status: AgentStatus;
}

export class HybridOrchestrator {
  private readonly adapters = new Map<AgentIdentifier, AgentEntry>();
  private activeAgentId: AgentIdentifier;
  private workingDirectory?: string;
  private model?: string;
  private readonly systemPromptManager?: SystemPromptManager;

  constructor(options: HybridOrchestratorOptions) {
    if (!options.adapters.length) {
      throw new Error("HybridOrchestrator requires at least one agent adapter");
    }
    this.systemPromptManager = options.systemPromptManager;

    for (const adapter of options.adapters) {
      this.registerAdapter(adapter);
    }

    this.workingDirectory = options.initialWorkingDirectory;
    this.model = options.initialModel;
    this.activeAgentId = this.resolveInitialAgent(options.defaultAgentId);

    if (this.workingDirectory) {
      this.broadcastWorkingDirectory(this.workingDirectory);
    }

    if (this.model) {
      this.broadcastModel(this.model);
    }
  }

  registerAdapter(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Agent with id "${adapter.id}" already registered`);
    }
    this.adapters.set(adapter.id, { adapter, metadata: adapter.metadata });
    if (!this.activeAgentId) {
      this.activeAgentId = adapter.id;
    }
    if (this.workingDirectory) {
      adapter.setWorkingDirectory?.(this.workingDirectory);
    }
    if (this.model) {
      adapter.setModel?.(this.model);
    }
  }

  private resolveInitialAgent(preferred?: AgentIdentifier): AgentIdentifier {
    if (preferred && this.adapters.has(preferred)) {
      return preferred;
    }
    const iterator = this.adapters.keys().next();
    if (iterator.done) {
      throw new Error("No agents available");
    }
    return iterator.value;
  }

  getActiveAgentId(): AgentIdentifier {
    return this.activeAgentId;
  }

  hasAgent(agentId: AgentIdentifier): boolean {
    return this.adapters.has(agentId);
  }

  listAgents(): AgentDescriptor[] {
    return Array.from(this.adapters.values()).map(({ adapter, metadata }) => ({
      metadata,
      status: adapter.status(),
    }));
  }

  switchAgent(agentId: AgentIdentifier): void {
    if (!this.adapters.has(agentId)) {
      throw new Error(`Agent "${agentId}" is not registered`);
    }
    this.activeAgentId = agentId;
  }

  private get activeEntry(): AgentEntry {
    const entry = this.adapters.get(this.activeAgentId);
    if (!entry) {
      throw new Error(`Active agent "${this.activeAgentId}" not found`);
    }
    return entry;
  }

  private mergeSystemPrompt(systemText: string, input: Input): Input {
    if (!systemText.trim()) {
      return input;
    }
    if (typeof input === "string") {
      return `${systemText}\n\n${input}`;
    }
    if (Array.isArray(input)) {
      return [{ type: "text", text: systemText }, ...input];
    }
    return `${systemText}\n\n${String(input ?? "")}`;
  }

  private applySystemPrompt(agentId: AgentIdentifier, input: Input): Input {
    if (!this.systemPromptManager) {
      return input;
    }
    // Codex already handles system prompt injection itself
    if (agentId === "codex") {
      return input;
    }
    const injection = this.systemPromptManager.maybeInject();
    if (!injection) {
      return input;
    }
    const entry = this.adapters.get(agentId);
    const agentName = entry?.metadata.name ?? agentId;
    const aliasNote =
      `You are ${agentName} (id: ${agentId}), the active ADS agent. ` +
      `If the following instructions mention "Codex", treat them as referring to you.`;
    const decorated = `${aliasNote}\n\n${injection.text}`;
    return this.mergeSystemPrompt(decorated, input);
  }

  private completeTurn(agentId: AgentIdentifier): void {
    if (!this.systemPromptManager) {
      return;
    }
    if (agentId === "codex") {
      // Codex session manages turn completion internally
      return;
    }
    this.systemPromptManager.completeTurn();
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return this.activeEntry.adapter.getStreamingConfig();
  }

  status(): AgentStatus & { agentId: AgentIdentifier } {
    const status = this.activeEntry.adapter.status();
    return { ...status, agentId: this.activeAgentId };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    return this.activeEntry.adapter.onEvent(handler);
  }

  reset(): void {
    for (const { adapter } of this.adapters.values()) {
      adapter.reset();
    }
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const prompt = this.applySystemPrompt(this.activeAgentId, input);
    try {
      return await this.activeEntry.adapter.send(prompt, options);
    } finally {
      this.completeTurn(this.activeAgentId);
    }
  }

  async invokeAgent(agentId: AgentIdentifier, input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const entry = this.adapters.get(agentId);
    if (!entry) {
      throw new Error(`Agent "${agentId}" is not registered`);
    }
    const prompt = this.applySystemPrompt(agentId, input);
    try {
      return await entry.adapter.send(prompt, options);
    } finally {
      this.completeTurn(agentId);
    }
  }

  setWorkingDirectory(workingDirectory?: string): void {
    this.workingDirectory = workingDirectory;
    this.systemPromptManager?.setWorkspaceRoot(workingDirectory ?? process.cwd());
    this.broadcastWorkingDirectory(workingDirectory);
  }

  private broadcastWorkingDirectory(workingDirectory?: string): void {
    for (const { adapter } of this.adapters.values()) {
      adapter.setWorkingDirectory?.(workingDirectory);
    }
  }

  setModel(model?: string): void {
    this.model = model;
    this.broadcastModel(model);
  }

  private broadcastModel(model?: string): void {
    for (const { adapter } of this.adapters.values()) {
      adapter.setModel?.(model);
    }
  }

  getThreadId(): string | null {
    return this.activeEntry.adapter.getThreadId?.() ?? null;
  }

  async classifyInput(input: string) {
    const adapter = this.activeEntry.adapter.classifyInput
      ? this.activeEntry.adapter
      : this.adapters.get("codex")?.adapter;

    if (!adapter || !adapter.classifyInput) {
      throw new Error("No agent available to classify input");
    }

    return adapter.classifyInput(input);
  }
}

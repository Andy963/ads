import type { Input } from "@openai/codex-sdk";
import {
  CodexSession,
  type CodexSendOptions,
  type CodexSendResult,
  type CodexSessionOptions,
} from "../../cli/codexChat.js";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../types.js";

function mapOptions(options?: AgentSendOptions): CodexSendOptions {
  if (!options) {
    return {};
  }
  const mapped: CodexSendOptions = {};
  if (options.streaming !== undefined) {
    mapped.streaming = options.streaming;
  }
  if (options.outputSchema !== undefined) {
    mapped.outputSchema = options.outputSchema;
  }
  if (options.signal) {
    mapped.signal = options.signal;
  }
  return mapped;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "codex",
  name: "Codex",
  vendor: "OpenAI",
  capabilities: ["text", "images", "files", "commands"],
};

export interface CodexAgentAdapterOptions extends CodexSessionOptions {
  metadata?: Partial<AgentMetadata>;
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly session: CodexSession;

  constructor(options: CodexAgentAdapterOptions = {}) {
    this.session = new CodexSession(options);
    this.metadata = {
      ...DEFAULT_METADATA,
      ...options.metadata,
      id: options.metadata?.id ?? DEFAULT_METADATA.id,
      name: options.metadata?.name ?? DEFAULT_METADATA.name,
      vendor: options.metadata?.vendor ?? DEFAULT_METADATA.vendor,
      capabilities: options.metadata?.capabilities ?? DEFAULT_METADATA.capabilities,
    };
    this.id = this.metadata.id;
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return this.session.getStreamingConfig();
  }

  status() {
    return this.session.status();
  }

  onEvent(handler: Parameters<CodexSession["onEvent"]>[0]): () => void {
    return this.session.onEvent(handler);
  }

  reset(): void {
    this.session.reset();
  }

  setWorkingDirectory(workingDirectory?: string): void {
    this.session.setWorkingDirectory(workingDirectory);
  }

  setModel(model?: string): void {
    this.session.setModel(model);
  }

  getThreadId(): string | null {
    return this.session.getThreadId();
  }

  async classifyInput(input: string) {
    return this.session.classifyInput(input);
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const result: CodexSendResult = await this.session.send(input, mapOptions(options));
    return {
      ...result,
      agentId: this.id,
    };
  }
}

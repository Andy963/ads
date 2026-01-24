import type { Input, Usage } from "@openai/codex-sdk";
import type { AgentEvent } from "../codex/events.js";
import type { IntakeClassification } from "../intake/types.js";
import type { ToolExecutionContext, ToolHooks } from "./tools.js";

export type AgentCapability = "text" | "images" | "files" | "commands";

export type AgentIdentifier = "codex" | string;

export interface AgentMetadata {
  id: AgentIdentifier;
  name: string;
  description?: string;
  vendor?: string;
  capabilities: AgentCapability[];
  defaultModel?: string;
}

export interface AgentStatus {
  ready: boolean;
  streaming: boolean;
  error?: string;
}

export interface AgentSendOptions {
  streaming?: boolean;
  outputSchema?: unknown;
  signal?: AbortSignal;
  toolContext?: ToolExecutionContext;
  toolHooks?: ToolHooks;
}

export interface AgentRunResult {
  response: string;
  usage: Usage | null;
  agentId: AgentIdentifier;
}

export interface AgentAdapter {
  readonly id: AgentIdentifier;
  readonly metadata: AgentMetadata;
  getStreamingConfig(): { enabled: boolean; throttleMs: number };
  status(): AgentStatus;
  send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  reset(): void;
  setWorkingDirectory?(workingDirectory?: string): void;
  setModel?(model?: string): void;
  getThreadId?(): string | null;
  classifyInput?(input: string): Promise<IntakeClassification>;
}

import type { AgentRunResult } from "../types.js";

export interface ToolCallSummary {
  tool: string;
  ok: boolean;
  inputPreview: string;
  outputPreview: string;
}

export interface ToolExecutionResult {
  tool: string;
  payload: string;
  ok: boolean;
  output: string;
  error?: string;
}

export interface ToolHooks {
  onInvoke?: (tool: string, payload: string) => void | Promise<void>;
  onResult?: (summary: ToolCallSummary) => void | Promise<void>;
}

export interface ToolResolutionOutcome extends AgentRunResult {
  toolSummaries: ToolCallSummary[];
}

export interface ToolInvocation {
  name: string;
  raw: string;
  payload: string;
}


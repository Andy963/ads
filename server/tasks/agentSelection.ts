import type { AgentIdentifier } from "../agents/types.js";

export function normalizeAgentId(raw: unknown): AgentIdentifier | null {
  const id = String(raw ?? "").trim();
  return id ? (id as AgentIdentifier) : null;
}

export function selectAgentForModel(_model?: string): AgentIdentifier {
  return "codex";
}

export function selectAgentForTask(_input: { agentId?: unknown; modelToUse: string }): AgentIdentifier {
  return "codex";
}

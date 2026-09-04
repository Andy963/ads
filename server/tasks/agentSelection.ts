import type { AgentIdentifier } from "../agents/types.js";

export function normalizeAgentId(raw: unknown): AgentIdentifier | null {
  const id = String(raw ?? "").trim();
  return id ? (id as AgentIdentifier) : null;
}

export function selectAgentForModel(_model?: string): AgentIdentifier {
  return "codex";
}

export function selectAgentForTask(input: { agentId?: unknown; modelToUse: string }): AgentIdentifier {
  const agentId = normalizeAgentId(input.agentId);
  if (agentId) {
    return agentId;
  }
  return "codex";
}

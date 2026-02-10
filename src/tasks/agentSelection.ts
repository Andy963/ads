import type { AgentIdentifier } from "../agents/types.js";

export function normalizeAgentId(raw: unknown): AgentIdentifier | null {
  const id = String(raw ?? "").trim();
  return id ? (id as AgentIdentifier) : null;
}

export function selectAgentForModel(model: string): AgentIdentifier {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (normalized.startsWith("gemini") || normalized.startsWith("auto-gemini") || normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.startsWith("claude") || normalized === "sonnet" || normalized === "opus" || normalized === "haiku") {
    return "claude";
  }
  if (normalized.startsWith("droid") || normalized.includes("droid")) {
    return "droid";
  }
  if (normalized.startsWith("amp") || normalized.includes("amp")) {
    return "amp";
  }
  return "codex";
}

export function selectAgentForTask(input: { agentId?: unknown; modelToUse: string }): AgentIdentifier {
  const agentId = normalizeAgentId(input.agentId);
  if (agentId) {
    return agentId;
  }
  return selectAgentForModel(input.modelToUse);
}


import type { ModelConfig } from "../api/types";

export type AgentKind = "codex" | "claude";

export const MODEL_AGENT_GROUPS: Array<{ kind: AgentKind; label: string; description: string }> = [
  { kind: "codex", label: "Codex CLI", description: "OpenAI Codex" },
  { kind: "claude", label: "Claude Code", description: "Anthropic Claude" },
];

export function modelAllowedAgents(model: ModelConfig): string[] | null {
  const cfg = (model as ModelConfig & { configJson?: unknown }).configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const raw = (cfg as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(raw)) return null;
  const agents = raw
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter(Boolean);
  return agents.length > 0 ? agents : null;
}

function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("claude") || id === "sonnet" || id === "opus" || id === "haiku";
}

export function resolveModelAgentId(model: ModelConfig, availableAgentIds: readonly string[] = []): string | null {
  const available = new Set(availableAgentIds.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean));
  const allowed = modelAllowedAgents(model);
  if (allowed) {
    const availableAllowed = allowed.find((id) => available.has(id));
    if (availableAllowed) return availableAllowed;
    if (allowed.length === 1) return allowed[0] ?? null;
  }

  const provider = String(model.provider ?? "").trim().toLowerCase();
  if (provider.includes("anthropic") || provider.includes("claude")) return "claude";
  if (provider.includes("openai") || provider.includes("codex")) return "codex";

  const modelId = String(model.modelId ?? model.id ?? "").trim();
  if (isClaudeModelId(modelId)) return "claude";
  if (modelId.toLowerCase().startsWith("gpt-") || modelId.toLowerCase().includes("codex")) return "codex";

  return allowed?.[0] ?? null;
}

export function supportsAgentModel(args: { agentId: string; model: ModelConfig }): boolean {
  const agentId = String(args.agentId ?? "").trim().toLowerCase();
  if (!agentId) return true;

  const allowed = modelAllowedAgents(args.model);
  if (allowed) {
    return allowed.includes(agentId);
  }

  const provider = String(args.model.provider ?? "").trim().toLowerCase();
  const modelId = String(args.model.modelId ?? args.model.id ?? "").trim();
  if (agentId === "claude") {
    if (provider.includes("anthropic")) return true;
    return isClaudeModelId(modelId);
  }
  if (agentId === "codex") {
    if (provider.includes("anthropic")) return false;
    if (isClaudeModelId(modelId)) return false;
    return true;
  }
  return false;
}

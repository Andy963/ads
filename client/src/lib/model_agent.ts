import type { ModelConfig } from "../api/types";

function getAllowedAgents(model: ModelConfig): string[] | null {
  const cfg = (model as ModelConfig & { configJson?: unknown }).configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const raw = (cfg as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(raw)) return null;
  const agents = raw
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter(Boolean);
  return agents.length > 0 ? agents : null;
}

function getModelRuntime(model: ModelConfig): string | null {
  const cfg = (model as ModelConfig & { configJson?: unknown }).configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const raw = (cfg as Record<string, unknown>).runtime;
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return trimmed || null;
}

function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("claude") || id === "sonnet" || id === "opus" || id === "haiku";
}

export function supportsAgentModel(args: { agentId: string; model: ModelConfig }): boolean {
  const agentId = String(args.agentId ?? "").trim().toLowerCase();
  if (!agentId) return true;

  // Models bound to a configured Settings -> Providers entry belong exclusively to Native runtime,
  // even if upgraded DB rows carry legacy `allowedAgents: ["codex"]`.
  const providerId = String(args.model.providerId ?? "").trim();
  if (providerId) {
    return agentId === "native";
  }

  const allowed = getAllowedAgents(args.model);
  if (allowed) {
    return allowed.includes(agentId);
  }

  const runtime = getModelRuntime(args.model);
  if (runtime === "native") {
    return agentId === "native";
  }
  if (runtime === "codex") {
    return agentId === "codex";
  }
  if (runtime === "agy") {
    return agentId === "agy" || agentId.startsWith("agy:");
  }

  const provider = String(args.model.provider ?? "").trim().toLowerCase();
  const modelId = String(args.model.modelId ?? args.model.id ?? "").trim();
  if (agentId === "native") {
    return provider !== "antigravity" && provider !== "codex";
  }
  if (agentId === "agy" || agentId.startsWith("agy:")) {
    return provider === "antigravity";
  }
  if (agentId === "claude") {
    if (provider.includes("anthropic")) return true;
    return isClaudeModelId(modelId);
  }
  if (agentId === "codex") {
    if (provider === "codex") return true;
    if (provider.includes("anthropic") || provider === "antigravity") return false;
    if (isClaudeModelId(modelId)) return false;
    return true;
  }
  return false;
}

import type { ModelConfig } from "../api/types";

function modelAllowedAgents(model: ModelConfig): string[] | null {
  const cfg = (model as ModelConfig & { configJson?: unknown }).configJson;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const raw = (cfg as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(raw)) return null;
  const agents = raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return agents.length > 0 ? agents : null;
}

function isClaudeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith("claude") || id === "sonnet" || id === "opus" || id === "haiku";
}

function isGeminiModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.includes("gemini") || id.startsWith("auto-gemini");
}

export function supportsAgentModel(args: { agentId: string; model: ModelConfig }): boolean {
  const agentId = String(args.agentId ?? "").trim().toLowerCase();
  if (!agentId) return true;

  const allowed = modelAllowedAgents(args.model);
  if (allowed) {
    return allowed.map((id) => id.toLowerCase()).includes(agentId);
  }

  const provider = String(args.model.provider ?? "").trim().toLowerCase();
  const modelId = String(args.model.modelId ?? args.model.id ?? "").trim();
  if (agentId === "claude") {
    if (provider.includes("anthropic")) return true;
    return isClaudeModelId(modelId);
  }
  if (agentId === "gemini") {
    if (provider.includes("google")) return true;
    return isGeminiModelId(modelId);
  }
  if (agentId === "codex") {
    if (provider.includes("anthropic") || provider.includes("google")) return false;
    if (isClaudeModelId(modelId) || isGeminiModelId(modelId)) return false;
    return true;
  }
  return true;
}

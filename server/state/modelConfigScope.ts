type ModelConfigLike = {
  modelId?: string | null;
  provider?: string | null;
  configJson?: unknown;
};

function normalizeAgentId(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function configuredAgents(config: ModelConfigLike): string[] {
  const rawConfig = config.configJson;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return [];
  const rawAgents = (rawConfig as Record<string, unknown>).allowedAgents;
  if (!Array.isArray(rawAgents)) return [];
  return [...new Set(rawAgents.map(normalizeAgentId).filter(Boolean))];
}

/** Infer the CLI scope used to isolate default model selection. */
export function modelConfigScopes(config: ModelConfigLike): string[] {
  const explicitAgents = configuredAgents(config);
  if (explicitAgents.length > 0) return explicitAgents;

  const provider = normalizeAgentId(config.provider);
  if (provider.includes("factory") || provider.includes("droid")) return ["droid"];
  if (provider.includes("anthropic") || provider.includes("claude")) return ["claude"];
  if (provider.includes("google") || provider.includes("gemini")) return ["gemini"];

  const modelId = normalizeAgentId(config.modelId);
  if (modelId.includes("gemini")) return ["gemini"];
  if (modelId.startsWith("claude") || modelId === "sonnet" || modelId === "opus" || modelId === "haiku") {
    return ["claude"];
  }

  return ["codex"];
}

export function modelConfigScopesOverlap(left: ModelConfigLike, right: ModelConfigLike): boolean {
  const rightScopes = new Set(modelConfigScopes(right));
  return modelConfigScopes(left).some((scope) => rightScopes.has(scope));
}

type ModelConfigLike = {
  modelId?: string | null;
  provider?: string | null;
  providerId?: string | null;
  configJson?: unknown;
};

/**
 * Every model still shares the single Codex conversation scope (one default
 * model across the chat runtime); models attached to a first-class provider
 * additionally classify under that provider's scope so multi-provider configs
 * can be told apart.
 */
export function modelConfigScopes(config: ModelConfigLike): string[] {
  const scopes = ["codex"];
  const providerId = String(config.providerId ?? "").trim();
  if (providerId) {
    scopes.push(`provider:${providerId}`);
  }
  return scopes;
}

export function modelConfigScopesOverlap(left: ModelConfigLike, right: ModelConfigLike): boolean {
  const rightScopes = new Set(modelConfigScopes(right));
  return modelConfigScopes(left).some((scope) => rightScopes.has(scope));
}

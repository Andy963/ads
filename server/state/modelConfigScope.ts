type ModelConfigLike = {
  modelId?: string | null;
  provider?: string | null;
  configJson?: unknown;
};

/** All configured models share one Codex runtime and one default scope. */
export function modelConfigScopes(_config: ModelConfigLike): string[] {
  return ["codex"];
}

export function modelConfigScopesOverlap(left: ModelConfigLike, right: ModelConfigLike): boolean {
  const rightScopes = new Set(modelConfigScopes(right));
  return modelConfigScopes(left).some((scope) => rightScopes.has(scope));
}

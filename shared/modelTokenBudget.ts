export const DEFAULT_MODEL_CONTEXT_WINDOW = 262_144;
export const DEFAULT_MODEL_OUTPUT_TOKENS = 131_072;
export const MIN_MODEL_CONTEXT_WINDOW = 256;
export const MAX_MODEL_TOKEN_LIMIT = 100_000_000;

export const MODEL_CONTEXT_KEYS = [
  "max_input_tokens",
  "contextWindow",
  "context_window",
  "modelContextWindow",
  "model_context_window",
  "maxContextTokens",
  "max_context_tokens",
] as const;
export const MODEL_OUTPUT_KEYS = ["max_output_tokens", "maxTokens"] as const;

export function normalizeModelTokenLimit(value: unknown, minimum = 1): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const tokens = Number(value);
  return Number.isSafeInteger(tokens) && tokens >= minimum && tokens <= MAX_MODEL_TOKEN_LIMIT
    ? tokens
    : undefined;
}

export function readModelTokenLimit(
  config: Record<string, unknown> | null | undefined,
  keys: readonly string[],
  minimum = 1,
): number | undefined {
  for (const key of keys) {
    const tokens = normalizeModelTokenLimit(config?.[key], minimum);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

export function defaultModelOutputTokens(contextWindow: number): number {
  // An unconfigured small model must retain useful input space too.
  return Math.min(DEFAULT_MODEL_OUTPUT_TOKENS, Math.floor(contextWindow / 2));
}

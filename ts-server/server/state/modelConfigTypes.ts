import { MIN_MODEL_CONTEXT_WINDOW, normalizeModelTokenLimit } from "../../shared/modelTokenBudget.js";

export interface ModelConfig {
  id: string;
  modelId?: string | null;
  displayName: string;
  provider: string;
  providerId?: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
  updatedAt?: number | null;
}

const STANDARD_MODEL_REASONING_EFFORTS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const standardModelReasoningEfforts = new Set<string>(STANDARD_MODEL_REASONING_EFFORTS);

export const DEFAULT_REASONING_EFFORT = "high";

export function normalizeConfiguredReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return standardModelReasoningEfforts.has(normalized) ? normalized : undefined;
}

export function sanitizeModelConfigJson(
  configJson: Record<string, unknown> | null | undefined,
  options: { defaultUnconfigured?: boolean } = {},
): Record<string, unknown> | null {
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) return null;

  const config = { ...configJson };
  for (const [key, minimum] of [
    ["max_input_tokens", MIN_MODEL_CONTEXT_WINDOW],
    ["max_output_tokens", 1],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue;
    const tokens = normalizeModelTokenLimit(config[key], minimum);
    if (tokens === undefined) {
      delete config[key];
    } else {
      config[key] = tokens;
    }
  }

  const hasReasoningEfforts = Object.prototype.hasOwnProperty.call(config, "reasoningEfforts");
  if (hasReasoningEfforts || options.defaultUnconfigured) {
    const rawEfforts = Array.isArray(config.reasoningEfforts) ? config.reasoningEfforts : [];
    const efforts = [
      ...new Set(
        rawEfforts
          .map((effort) => normalizeConfiguredReasoningEffort(effort))
          .filter((effort): effort is string => Boolean(effort)),
      ),
    ];

    if (efforts.length === 0) {
      config.reasoningEfforts = ["medium", DEFAULT_REASONING_EFFORT];
      config.defaultReasoningEffort = DEFAULT_REASONING_EFFORT;
    } else {
      config.reasoningEfforts = efforts;
      const configuredDefault = normalizeConfiguredReasoningEffort(config.defaultReasoningEffort);
      if (configuredDefault && efforts.includes(configuredDefault)) {
        config.defaultReasoningEffort = configuredDefault;
      } else if (Object.prototype.hasOwnProperty.call(config, "defaultReasoningEffort")) {
        config.defaultReasoningEffort = efforts.includes(DEFAULT_REASONING_EFFORT)
          ? DEFAULT_REASONING_EFFORT
          : efforts[0];
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(config, "defaultReasoningEffort")) {
    config.defaultReasoningEffort =
      normalizeConfiguredReasoningEffort(config.defaultReasoningEffort) ?? DEFAULT_REASONING_EFFORT;
  }

  if (Object.prototype.hasOwnProperty.call(config, "reasoningEffort")) {
    const reasoningEffort = normalizeConfiguredReasoningEffort(config.reasoningEffort);
    if (reasoningEffort) {
      config.reasoningEffort = reasoningEffort;
    } else {
      delete config.reasoningEffort;
    }
  }

  return config;
}

export interface ModelConfig {
  id: string;
  modelId?: string | null;
  displayName: string;
  provider: string;
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
      config.reasoningEfforts = ["high"];
      config.defaultReasoningEffort = "high";
    } else {
      config.reasoningEfforts = efforts;
      const configuredDefault = normalizeConfiguredReasoningEffort(config.defaultReasoningEffort);
      if (configuredDefault && efforts.includes(configuredDefault)) {
        config.defaultReasoningEffort = configuredDefault;
      } else if (Object.prototype.hasOwnProperty.call(config, "defaultReasoningEffort")) {
        config.defaultReasoningEffort = efforts.includes("high") ? "high" : efforts[0];
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(config, "defaultReasoningEffort")) {
    config.defaultReasoningEffort = normalizeConfiguredReasoningEffort(config.defaultReasoningEffort) ?? "high";
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

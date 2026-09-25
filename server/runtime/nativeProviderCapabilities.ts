export type NativeProviderCapabilityStatus = "supported" | "unsupported" | "unknown";

export interface NativeProviderCapabilities {
  streaming: NativeProviderCapabilityStatus;
  nonStreaming: NativeProviderCapabilityStatus;
  toolCalls: NativeProviderCapabilityStatus;
  parallelToolCalls: NativeProviderCapabilityStatus;
  imageInput: NativeProviderCapabilityStatus;
  structuredOutput: NativeProviderCapabilityStatus;
  reasoningEffort: NativeProviderCapabilityStatus;
  usage: NativeProviderCapabilityStatus;
  contextMetadata: NativeProviderCapabilityStatus;
  providerOptions: NativeProviderCapabilityStatus;
}

export const DEFAULT_NATIVE_PROVIDER_CAPABILITIES: Readonly<NativeProviderCapabilities> = {
  streaming: "supported",
  nonStreaming: "supported",
  toolCalls: "supported",
  parallelToolCalls: "supported",
  imageInput: "unsupported",
  structuredOutput: "unknown",
  reasoningEffort: "unknown",
  usage: "supported",
  contextMetadata: "supported",
  providerOptions: "unknown",
};

export class NativeCapabilityError extends Error {
  readonly code = "NATIVE_CAPABILITY_UNSUPPORTED";

  constructor(capability: keyof NativeProviderCapabilities, detail?: string) {
    super(`Native provider capability "${capability}" is unavailable${detail ? `: ${detail}` : "."}`);
    this.name = "NativeCapabilityError";
  }
}

function status(value: unknown): NativeProviderCapabilityStatus | undefined {
  return value === "supported" || value === "unsupported" || value === "unknown" ? value : undefined;
}

function booleanStatus(value: unknown): NativeProviderCapabilityStatus | undefined {
  return value === true ? "supported" : value === false ? "unsupported" : undefined;
}

export function resolveNativeProviderCapabilities(
  value: unknown,
): NativeProviderCapabilities {
  const result = { ...DEFAULT_NATIVE_PROVIDER_CAPABILITIES };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const outer = value as Record<string, unknown>;
  const nested = outer.capabilities && typeof outer.capabilities === "object" && !Array.isArray(outer.capabilities)
    ? outer.capabilities as Record<string, unknown>
    : null;
  const record = nested ? { ...outer, ...nested } : outer;
  const read = (key: keyof NativeProviderCapabilities): NativeProviderCapabilityStatus | undefined => {
    const direct = status(record[key]);
    if (direct) return direct;
    const booleanValue = booleanStatus(record[key]);
    if (booleanValue) return booleanValue;
    return undefined;
  };
  for (const key of Object.keys(result) as Array<keyof NativeProviderCapabilities>) {
    result[key] = read(key) ?? result[key];
  }
  result.structuredOutput = status(record.structuredOutput)
    ?? booleanStatus(record.supportsStructuredOutput)
    ?? result.structuredOutput;
  result.reasoningEffort = status(record.reasoningEffort)
    ?? booleanStatus(record.supportsReasoningEffort)
    ?? booleanStatus(record.reasoningEffortSupported)
    ?? result.reasoningEffort;
  result.imageInput = status(record.imageInput)
    ?? booleanStatus(record.supportsImageInput)
    ?? result.imageInput;
  result.providerOptions = status(record.providerOptions)
    ?? booleanStatus(record.supportsProviderOptions)
    ?? result.providerOptions;
  return result;
}

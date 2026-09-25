import type { AgentCapability } from "../agents/types.js";
import {
  RUNTIME_CAPABILITY_MATRIX,
  resolveAgentRuntime,
  type AgentRuntimeBackend,
  type RuntimeCapability,
} from "../runtime/config.js";

export const ACTIONS_REQUIRED_CAPABILITIES: readonly AgentCapability[] = [
  "text",
  "files",
  "commands",
];

export interface ActionsRuntimePreflightInput {
  backend?: AgentRuntimeBackend;
  capabilities?: readonly AgentCapability[];
  runtimeCapabilities?: Partial<Record<RuntimeCapability, "supported" | "unsupported" | "intentionally-different">>;
  requireDurableState?: boolean;
  requireProviderResume?: boolean;
}

export interface ActionsRuntimePreflightResult {
  ok: boolean;
  backend: AgentRuntimeBackend;
  missingCapabilities: AgentCapability[];
  unsupportedRuntimeCapabilities: RuntimeCapability[];
  reason?: string;
}

function uniqueCapabilities(capabilities: readonly AgentCapability[]): Set<AgentCapability> {
  return new Set(capabilities);
}

/**
 * Validate the runtime contract required by the Actions lane before a branch is
 * checked out or a Developer session is created.
 */
export function checkActionsRuntimePreflight(
  input: ActionsRuntimePreflightInput = {},
): ActionsRuntimePreflightResult {
  const backend = input.backend ?? resolveAgentRuntime();
  const available = uniqueCapabilities(input.capabilities ?? ACTIONS_REQUIRED_CAPABILITIES);
  const missingCapabilities = ACTIONS_REQUIRED_CAPABILITIES.filter((capability) => !available.has(capability));
  const unsupportedRuntimeCapabilities: RuntimeCapability[] = [];
  const matrix = {
    ...RUNTIME_CAPABILITY_MATRIX[backend],
    ...(input.runtimeCapabilities ?? {}),
  };

  const requireRuntimeCapability = (capability: RuntimeCapability): void => {
    if (matrix[capability] === "unsupported") {
      unsupportedRuntimeCapabilities.push(capability);
    }
  };

  if (input.requireDurableState) {
    requireRuntimeCapability("durable-thread-state");
  }
  if (input.requireProviderResume) {
    requireRuntimeCapability("provider-thread-resume");
  }
  const reason = missingCapabilities.length > 0 || unsupportedRuntimeCapabilities.length > 0
    ? [
      missingCapabilities.length > 0
        ? `missing capabilities: ${missingCapabilities.join(", ")}`
        : "",
      unsupportedRuntimeCapabilities.length > 0
        ? `unsupported runtime capabilities: ${unsupportedRuntimeCapabilities.join(", ")}`
        : "",
    ].filter(Boolean).join("; ")
    : undefined;

  return {
    ok: !reason,
    backend,
    missingCapabilities,
    unsupportedRuntimeCapabilities,
    ...(reason ? { reason } : {}),
  };
}

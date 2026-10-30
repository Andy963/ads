import { createLogger } from "../utils/logger.js";

export type AgentRuntimeBackend = "codex-app-server" | "native";

export const DEFAULT_AGENT_RUNTIME: AgentRuntimeBackend = "native";

const logger = createLogger("RuntimeConfig");

export type SessionLifecycle = "durable" | "ephemeral";

export type RuntimeCapabilityStatus = "supported" | "unsupported" | "intentionally-different";

export type RuntimeCapability =
  | "provider-thread-resume"
  | "history-injection"
  | "durable-thread-state"
  | "cross-runtime-resume";

export type RuntimeCapabilityMatrix = Record<
  AgentRuntimeBackend,
  Record<RuntimeCapability, RuntimeCapabilityStatus>
>;

export const RUNTIME_CAPABILITY_MATRIX: RuntimeCapabilityMatrix = {
  "codex-app-server": {
    "provider-thread-resume": "supported",
    "history-injection": "supported",
    "durable-thread-state": "supported",
    "cross-runtime-resume": "unsupported",
  },
  native: {
    "provider-thread-resume": "intentionally-different",
    "history-injection": "supported",
    "durable-thread-state": "intentionally-different",
    "cross-runtime-resume": "unsupported",
  },
};

export function resolveAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntimeBackend {
  const value = String(env.ADS_AGENT_RUNTIME ?? "").trim().toLowerCase();
  if (!value) {
    return DEFAULT_AGENT_RUNTIME;
  }
  if (value === "native" || value === "in-process") {
    return "native";
  }
  if (value === "codex-app-server" || value === "codex" || value === "cli") {
    return "codex-app-server";
  }
  // An unknown value must not silently select the full-access native runtime.
  logger.warn(`Unknown ADS_AGENT_RUNTIME "${value}"; falling back to codex-app-server.`);
  return "codex-app-server";
}

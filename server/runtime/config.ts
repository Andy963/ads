export type AgentRuntimeBackend = "codex-app-server" | "native";

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
  return value === "native" || value === "in-process" ? "native" : "codex-app-server";
}

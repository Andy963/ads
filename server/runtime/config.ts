export type AgentRuntimeBackend = "codex-app-server" | "native";

export function resolveAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntimeBackend {
  const value = String(env.ADS_AGENT_RUNTIME ?? "").trim().toLowerCase();
  return value === "native" || value === "in-process" ? "native" : "codex-app-server";
}

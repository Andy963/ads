export interface AgentFeatureFlags {
  codexEnabled: boolean;
}

export function getAgentFeatureFlags(): AgentFeatureFlags {
  return {
    codexEnabled: true,
  };
}

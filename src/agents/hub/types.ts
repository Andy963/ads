import type { ExploredEntry, ExploredEntryCallback } from "../../utils/activityTracker.js";

import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "../types.js";

export interface DelegationDirective {
  raw: string;
  agentId: AgentIdentifier;
  prompt: string;
}

export interface DelegationSummary {
  agentId: AgentIdentifier;
  agentName: string;
  prompt: string;
  response: string;
}

export interface CollaborationHooks {
  onDelegationStart?: (summary: { agentId: AgentIdentifier; agentName: string; prompt: string }) => void | Promise<void>;
  onDelegationResult?: (summary: DelegationSummary) => void | Promise<void>;
  onSupervisorRound?: (round: number, directives: number) => void | Promise<void>;
}

export interface CollaborativeTurnOptions extends AgentSendOptions {
  maxSupervisorRounds?: number;
  maxDelegations?: number;
  cwd?: string;
  historyNamespace?: string;
  historySessionId?: string;
  hooks?: CollaborationHooks;
  onExploredEntry?: ExploredEntryCallback;
}

export interface CollaborativeTurnResult extends AgentRunResult {
  delegations: DelegationSummary[];
  supervisorRounds: number;
  explored?: ExploredEntry[];
}

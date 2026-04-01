import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { AgentIdentifier } from "../../../agents/types.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

import { preferInMemoryThreadId } from "./threadIds.js";

type EffectiveState = ReturnType<SessionManager["getEffectiveState"]>;
type Orchestrator = ReturnType<SessionManager["getOrCreate"]>;

export type WsBootstrapState = {
  threadId: string | null;
  contextMode: ReturnType<SessionManager["getContextRestoreMode"]>;
  effectiveState: EffectiveState;
  agents: Array<{ id: string; name: string; ready: boolean; error?: string }>;
};

export function buildWsBootstrapState(args: {
  sessionManager: SessionManager;
  orchestrator: Orchestrator;
  userId: number;
  agentAvailability: AgentAvailability;
}): WsBootstrapState {
  const { sessionManager, orchestrator, userId, agentAvailability } = args;
  const activeAgentId = orchestrator.getActiveAgentId();
  return {
    threadId: preferInMemoryThreadId({
      inMemoryThreadId: orchestrator.getThreadId(),
      savedThreadId: sessionManager.getSavedThreadId(userId, activeAgentId),
    }),
    contextMode: sessionManager.getContextRestoreMode(userId),
    effectiveState: sessionManager.getEffectiveState(userId),
    agents: orchestrator.listAgents().map((entry) => {
      const merged = agentAvailability.mergeStatus(entry.metadata.id, entry.status);
      return {
        id: entry.metadata.id,
        name: entry.metadata.name,
        ready: merged.ready,
        error: merged.error,
      };
    }),
  };
}

export function buildWelcomePayload(args: {
  sessionId: string;
  chatSessionId: string;
  workspace: unknown;
  inFlight: boolean;
  state: WsBootstrapState;
}): Record<string, unknown> {
  return {
    type: "welcome",
    message: "ADS WebSocket bridge ready.",
    workspace: args.workspace,
    sessionId: args.sessionId,
    chatSessionId: args.chatSessionId,
    inFlight: args.inFlight,
    threadId: args.state.threadId,
    effectiveModel: args.state.effectiveState.model,
    effectiveModelReasoningEffort: args.state.effectiveState.modelReasoningEffort,
    activeAgentId: args.state.effectiveState.activeAgentId,
    contextMode: args.state.contextMode,
  };
}

export function buildAgentsPayload(args: {
  activeAgentId: AgentIdentifier;
  state: WsBootstrapState;
}): Record<string, unknown> {
  return {
    type: "agents",
    activeAgentId: args.activeAgentId,
    agents: args.state.agents,
    threadId: args.state.threadId,
  };
}

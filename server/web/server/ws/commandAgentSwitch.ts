import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { WsOrchestrator } from "./deps.js";
import { preferInMemoryThreadId } from "./threadIds.js";

function readAgentId(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  return String((payload as Record<string, unknown>).agentId ?? "").trim();
}

export function handleSetAgentCommand(args: {
  payload: unknown;
  userId: number;
  currentCwd: string;
  orchestrator: WsOrchestrator;
  sessionManager: SessionManager;
  agentAvailability: AgentAvailability;
  sendToClient: (payload: unknown) => void;
}): WsOrchestrator {
  const agentId = readAgentId(args.payload);

  if (!agentId) {
    args.sendToClient({ type: "error", message: "Payload must include agentId" });
    return args.orchestrator;
  }

  const switchResult = args.sessionManager.switchAgent(args.userId, agentId);
  if (!switchResult.success) {
    args.sendToClient({ type: "error", message: switchResult.message });
    return args.orchestrator;
  }

  const orchestrator = args.sessionManager.getOrCreate(args.userId, args.currentCwd);
  const activeAgentId = orchestrator.getActiveAgentId();
  args.sendToClient({
    type: "agents",
    activeAgentId,
    agents: orchestrator.listAgents().map((entry) => {
      const merged = args.agentAvailability.mergeStatus(entry.metadata.id, entry.status);
      return {
        id: entry.metadata.id,
        name: entry.metadata.name,
        ready: merged.ready,
        error: merged.error,
      };
    }),
    threadId: preferInMemoryThreadId({
      inMemoryThreadId: orchestrator.getThreadId(),
      savedThreadId: args.sessionManager.getSavedThreadId(args.userId, activeAgentId),
    }),
  });

  return orchestrator;
}

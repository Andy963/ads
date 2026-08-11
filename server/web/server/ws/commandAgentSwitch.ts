import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsOrchestrator } from "./deps.js";
import { preferInMemoryThreadId } from "./threadIds.js";

function readAgentId(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const rec = payload as Record<string, unknown>;
  return String(rec.agentId ?? rec.agent_id ?? rec.agent ?? "").trim();
}

export function handleSetAgentCommand(args: {
  payload: unknown;
  userId: number;
  historyKey: string;
  currentCwd: string;
  orchestrator: WsOrchestrator;
  sessionManager: SessionManager;
  historyStore: Pick<HistoryStore, "add">;
  agentAvailability: AgentAvailability;
  sendToSession: (payload: unknown) => void;
}): WsOrchestrator {
  const agentId = readAgentId(args.payload);

  if (!agentId) {
    const message = "Payload must include agentId";
    args.sendToSession({ type: "error", message });
    args.historyStore.add(args.historyKey, { role: "status", text: message, ts: Date.now(), kind: "error" });
    return args.orchestrator;
  }

  const switchResult = args.sessionManager.switchAgent(args.userId, agentId);
  if (!switchResult.success) {
    args.sendToSession({ type: "error", message: switchResult.message });
    args.historyStore.add(args.historyKey, { role: "status", text: switchResult.message, ts: Date.now(), kind: "error" });
    return args.orchestrator;
  }

  const orchestrator = args.sessionManager.getOrCreate(args.userId, args.currentCwd, true);
  const activeAgentId = orchestrator.getActiveAgentId();
  const agents = orchestrator.listAgents().map((entry) => {
    const merged = args.agentAvailability.mergeStatus(entry.metadata.id, entry.status);
    return {
      id: entry.metadata.id,
      name: entry.metadata.name,
      ready: merged.ready,
      error: merged.error,
    };
  });
  args.sendToSession({
    type: "agents",
    activeAgentId,
    agents,
    threadId: preferInMemoryThreadId({
      inMemoryThreadId: orchestrator.getThreadId(),
      savedThreadId: args.sessionManager.getSavedThreadId(args.userId, activeAgentId),
    }),
  });

  return orchestrator;
}

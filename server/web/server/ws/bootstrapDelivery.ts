import type { WebSocket } from "ws";

import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryEntry, HistoryStore } from "../../../utils/historyStore.js";
import { buildAgentsPayload, buildWelcomePayload, buildWsBootstrapState } from "./bootstrapState.js";
import { buildHistoryBootstrapPayload } from "./bootstrapReplay.js";

function buildContextRestoreStatus(contextMode: string): string | null {
  if (contextMode === "thread_resumed") {
    return "已恢复后端上下文线程。";
  }
  if (contextMode === "history_injection") {
    return "后端线程未直接恢复；下一轮发送时会注入最近聊天历史来延续上下文。";
  }
  return null;
}

function buildInFlightStatus(inFlight: boolean): string | null {
  return inFlight ? "上一轮仍在执行，正在等待后端结果。" : null;
}

function isReplayableBuiltinStatus(entry: HistoryEntry): boolean {
  if (entry.role !== "status" || entry.kind !== "status") {
    return false;
  }
  const text = String(entry.text ?? "").trim();
  return text.startsWith("当前工作目录:") || text.startsWith("已切换到:");
}

function shouldReplayFreshHistory(entries: HistoryEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || !String(entry.text ?? "").trim()) {
      continue;
    }
    if (entry.role === "status" && entry.kind === "status" && !isReplayableBuiltinStatus(entry)) {
      continue;
    }
    return entry.role === "status" && (entry.kind === "error" || entry.kind === "execute" || isReplayableBuiltinStatus(entry));
  }
  return false;
}

export function sendInitialBootstrapMessages(args: {
  ws: WebSocket;
  safeJsonSend: (ws: WebSocket, payload: unknown) => void;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  userId: number;
  agentAvailability: AgentAvailability;
  sessionId: string;
  chatSessionId: string;
  workspace: unknown;
  inFlight: boolean;
  historyStore: HistoryStore;
  historyKey: string;
}): void {
  const bootstrapState = buildWsBootstrapState({
    sessionManager: args.sessionManager,
    orchestrator: args.orchestrator,
    userId: args.userId,
    agentAvailability: args.agentAvailability,
    allowSavedThreadFallback: true,
  });

  args.safeJsonSend(
    args.ws,
    buildWelcomePayload({
      sessionId: args.sessionId,
      chatSessionId: args.chatSessionId,
      workspace: args.workspace,
      inFlight: args.inFlight,
      state: bootstrapState,
    }),
  );
  args.safeJsonSend(
    args.ws,
    buildAgentsPayload({
      activeAgentId: args.orchestrator.getActiveAgentId(),
      state: bootstrapState,
    }),
  );

  const historyEntries = args.historyStore.get(args.historyKey);
  const shouldReplayHistory =
    args.inFlight ||
    bootstrapState.contextMode !== "fresh" ||
    Boolean(bootstrapState.threadId) ||
    shouldReplayFreshHistory(historyEntries);
  const historyPayload = shouldReplayHistory ? buildHistoryBootstrapPayload(historyEntries) ?? { type: "history", items: [] } : null;
  if (historyPayload) {
    args.safeJsonSend(args.ws, historyPayload);
  }
  const restoreStatus = buildContextRestoreStatus(bootstrapState.contextMode);
  if (restoreStatus) {
    args.safeJsonSend(args.ws, { type: "status", message: restoreStatus, kind: "status" });
  }
  const inFlightStatus = buildInFlightStatus(args.inFlight);
  if (inFlightStatus) {
    args.safeJsonSend(args.ws, { type: "status", message: inFlightStatus, kind: "status" });
  }
}

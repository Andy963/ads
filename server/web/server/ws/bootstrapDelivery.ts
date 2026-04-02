import type { WebSocket } from "ws";

import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { buildAgentsPayload, buildWelcomePayload, buildWsBootstrapState } from "./bootstrapState.js";
import { buildHistoryBootstrapPayload, buildReviewerBootstrapPayloads } from "./bootstrapReplay.js";
import { hasReviewerSnapshotContext } from "./reviewerSnapshotContext.js";

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
  isReviewerChat: boolean;
  boundSnapshotId: string | null;
  latestArtifact?: Record<string, unknown> | null;
}): void {
  const allowReviewerContinuityBootstrap =
    !args.isReviewerChat || hasReviewerSnapshotContext({ boundSnapshotId: args.boundSnapshotId });
  const bootstrapState = buildWsBootstrapState({
    sessionManager: args.sessionManager,
    orchestrator: args.orchestrator,
    userId: args.userId,
    agentAvailability: args.agentAvailability,
    allowSavedThreadFallback: allowReviewerContinuityBootstrap,
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

  const historyPayload = buildHistoryBootstrapPayload(args.historyStore.get(args.historyKey));
  if (historyPayload && allowReviewerContinuityBootstrap) {
    args.safeJsonSend(args.ws, historyPayload);
  }

  const reviewerBootstrapPayloads = buildReviewerBootstrapPayloads({
    isReviewerChat: args.isReviewerChat,
    boundSnapshotId: args.boundSnapshotId,
    latestArtifact: args.latestArtifact,
  });
  for (const payload of reviewerBootstrapPayloads) {
    args.safeJsonSend(args.ws, payload);
  }
}

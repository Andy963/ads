import type { WebSocket } from "ws";

import type { Input } from "../../../agents/protocol/types.js";
import type { ReviewArtifact, ReviewStore, ReviewSnapshot } from "../../../tasks/reviewStore.js";
import { toReviewArtifactSummary } from "../../../tasks/reviewStore.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsPromptSessionLogger } from "./deps.js";
import { extractInputText } from "./reviewerGuards.js";
import { summarizeReviewerArtifactText } from "./reviewerSnapshotContext.js";

type EffectiveState = ReturnType<SessionManager["getEffectiveState"]>;

export function createReviewerArtifact(args: {
  reviewStore: Pick<ReviewStore, "getLatestArtifact" | "createArtifact">;
  snapshot: Pick<ReviewSnapshot, "id" | "taskId">;
  historyKey: string;
  inputToSend: Input;
  output: string;
  now?: number;
}): ReviewArtifact {
  const previousArtifact = args.reviewStore.getLatestArtifact({ snapshotId: args.snapshot.id });
  return args.reviewStore.createArtifact(
    {
      taskId: args.snapshot.taskId,
      snapshotId: args.snapshot.id,
      scope: "reviewer",
      historyKey: args.historyKey,
      promptText: extractInputText(args.inputToSend),
      responseText: args.output,
      summaryText: summarizeReviewerArtifactText(args.output),
      verdict: "analysis",
      priorArtifactId: previousArtifact?.id ?? null,
    },
    args.now ?? Date.now(),
  );
}

export function publishReviewerPromptResult(args: {
  output: string;
  threadId: string | undefined;
  effectiveState: EffectiveState;
  rotationNotice: string | null | undefined;
  artifact: ReviewArtifact;
  sendToChat: (payload: unknown) => void;
  sessionLogger: WsPromptSessionLogger | null;
  historyStore: HistoryStore;
  historyKey: string;
  sendWorkspaceState: (ws: WebSocket, workspaceRoot: string) => void;
  ws: WebSocket;
  workspaceRoot: string;
}): void {
  args.sendToChat({
    type: "result",
    ok: true,
    output: args.output,
    threadId: args.threadId,
    effectiveModel: args.effectiveState.model,
    effectiveModelReasoningEffort: args.effectiveState.modelReasoningEffort,
    activeAgentId: args.effectiveState.activeAgentId,
    notice: args.rotationNotice,
  });
  args.sendToChat({ type: "reviewer_artifact", artifact: toReviewArtifactSummary(args.artifact) });
  if (args.sessionLogger) {
    args.sessionLogger.attachThreadId(args.threadId);
    args.sessionLogger.logOutput(args.output);
  }
  args.historyStore.add(args.historyKey, { role: "ai", text: args.output, ts: Date.now() });
  args.sendWorkspaceState(args.ws, args.workspaceRoot);
}

import type { Input } from "../../../agents/protocol/types.js";

import { runCollaborativeTurn } from "../../../agents/hub.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { toReviewArtifactSummary } from "../../../tasks/reviewStore.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import type { WsPromptHandlerDeps } from "./deps.js";
import { handlePromptError } from "./promptErrorHandling.js";
import { isReviewerWriteLikeRequest } from "./reviewerGuards.js";
import { createReviewerArtifact, publishReviewerPromptResult } from "./reviewerPromptArtifact.js";
import { buildReviewerPromptInput } from "./reviewerPromptInput.js";
import {
  finishReviewerPromptEarly,
  handleReviewerOrchestratorUnavailable,
} from "./reviewerPromptLifecycle.js";
import { parseReviewerSnapshotId, shouldResumeReviewerThread } from "./reviewerSnapshotContext.js";
import { applySessionOverrides } from "./sessionOverrides.js";

export { extractInputText } from "./reviewerGuards.js";

export async function handleReviewerPromptMessage(args: {
  deps: WsPromptHandlerDeps;
  workspaceRoot: string;
  turnCwd: string;
  inputToSend: Input;
  controller: AbortController;
  sendToClient: (payload: unknown) => void;
  sendToChat: (payload: unknown) => void;
  cleanupAfter: () => void;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  const { deps, workspaceRoot, turnCwd, inputToSend, controller, sendToClient, sendToChat, cleanupAfter } = args;
  if (deps.context.chatSessionId !== "reviewer") {
    return { handled: false, orchestrator: deps.sessions.orchestrator };
  }

  const taskCtx = deps.tasks.ensureTaskContext?.(workspaceRoot);
  const reviewStore = taskCtx?.reviewStore;
  const requestedSnapshotId = parseReviewerSnapshotId(deps.request.parsed.payload);
  const boundSnapshotId = String(deps.reviewerSnapshotBindings?.get(deps.context.historyKey) ?? "").trim();
  if (!reviewStore) {
    finishReviewerPromptEarly({
      output: "Reviewer lane needs task review context before it can analyze changes.",
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendToChat,
      sendWorkspaceState: deps.transport.sendWorkspaceState,
      ws: deps.transport.ws,
      workspaceRoot: turnCwd,
      interruptControllers: deps.sessions.interruptControllers,
      cleanupAfter,
    });
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }
  if (requestedSnapshotId && boundSnapshotId && requestedSnapshotId !== boundSnapshotId) {
    finishReviewerPromptEarly({
      output:
        `Reviewer is already bound to snapshot ${boundSnapshotId}. ` +
        `Clear reviewer context before switching to snapshot ${requestedSnapshotId}.`,
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendToChat,
      sendWorkspaceState: deps.transport.sendWorkspaceState,
      ws: deps.transport.ws,
      workspaceRoot: turnCwd,
      interruptControllers: deps.sessions.interruptControllers,
      cleanupAfter,
    });
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }

  const effectiveSnapshotId = requestedSnapshotId || boundSnapshotId;
  if (!effectiveSnapshotId) {
    finishReviewerPromptEarly({
      output: "Reviewer lane needs an explicit snapshotId. Select a task snapshot first.",
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendToChat,
      sendWorkspaceState: deps.transport.sendWorkspaceState,
      ws: deps.transport.ws,
      workspaceRoot: turnCwd,
      interruptControllers: deps.sessions.interruptControllers,
      cleanupAfter,
    });
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }

  const snapshot = reviewStore.getSnapshot(effectiveSnapshotId);
  if (!snapshot) {
    finishReviewerPromptEarly({
      output: `Reviewer snapshot not found: ${effectiveSnapshotId}`,
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendToChat,
      sendWorkspaceState: deps.transport.sendWorkspaceState,
      ws: deps.transport.ws,
      workspaceRoot: turnCwd,
      interruptControllers: deps.sessions.interruptControllers,
      cleanupAfter,
    });
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }

  const reviewerCwd = String(snapshot.worktreeDir ?? "").trim() || turnCwd;
  const orchestrator = deps.sessions.sessionManager.getOrCreate(
    deps.context.userId,
    reviewerCwd,
    shouldResumeReviewerThread({
      requestedSnapshotId,
      boundSnapshotId,
      hasSession: deps.sessions.sessionManager.hasSession(deps.context.userId),
    }),
  );
  const status = orchestrator.status();
  if (!status.ready) {
    handleReviewerOrchestratorUnavailable({
      errorMessage: status.error ?? "代理未启用，请配置凭证",
      sessionLogger: deps.observability.sessionLogger,
      sendToClient,
      interruptControllers: deps.sessions.interruptControllers,
      historyKey: deps.context.historyKey,
      cleanupAfter,
    });
    return { handled: true, orchestrator };
  }

  orchestrator.setWorkingDirectory(reviewerCwd);
  if (requestedSnapshotId && !boundSnapshotId) {
    deps.reviewerSnapshotBindings?.set(deps.context.historyKey, requestedSnapshotId);
    sendToClient({ type: "reviewer_snapshot_binding", snapshotId: requestedSnapshotId, taskId: snapshot.taskId });
  }

  const { notice: rotationNotice } = applySessionOverrides({
    sessionManager: deps.sessions.sessionManager,
    userId: deps.context.userId,
    payload: deps.request.parsed.payload,
  });

  if (isReviewerWriteLikeRequest(inputToSend)) {
    finishReviewerPromptEarly({
      output:
        `Reviewer stays read-only for snapshot ${snapshot.id}. ` +
        "I can analyze the snapshot, explain risks, or suggest changes, but I will not edit files or create drafts/specs/ADRs/schedules.",
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendToChat,
      sendWorkspaceState: deps.transport.sendWorkspaceState,
      ws: deps.transport.ws,
      workspaceRoot: turnCwd,
      interruptControllers: deps.sessions.interruptControllers,
      cleanupAfter,
    });
    return { handled: true, orchestrator };
  }

  try {
    const shouldInjectHistory = deps.sessions.sessionManager.needsHistoryInjection(deps.context.userId);
    const { effectiveInput, injectedHistoryCount } = buildReviewerPromptInput({
      inputToSend,
      snapshot,
      latestArtifact: (() => {
        const latest = reviewStore.getLatestArtifact({ snapshotId: snapshot.id });
        return latest ? toReviewArtifactSummary(latest) : null;
      })(),
      historyEntries: deps.history.historyStore.get(deps.context.historyKey),
      receivedAt: deps.request.receivedAt,
      injectHistory: shouldInjectHistory,
    });
    if (shouldInjectHistory) {
      if (injectedHistoryCount > 0) {
        deps.observability.logger.info(
          `[ContextRestore] Injected ${injectedHistoryCount} history entries for reviewer user=${deps.context.userId} session=${deps.context.sessionId}`,
        );
      }
      deps.sessions.sessionManager.clearHistoryInjection(deps.context.userId);
    }

    const result = await runCollaborativeTurn(orchestrator, effectiveInput, {
      streaming: true,
      signal: controller.signal,
      cwd: reviewerCwd,
      historyNamespace: "web",
      historySessionId: deps.context.historyKey,
    });
    const rawResponse = typeof result.response === "string" ? result.response : String(result.response ?? "");
    const output = stripLeadingTranslation(rawResponse);
    const threadId = orchestrator.getThreadId();

    const artifact = createReviewerArtifact({
      reviewStore,
      snapshot,
      historyKey: deps.context.historyKey,
      inputToSend,
      output,
    });

    if (threadId) {
      deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, orchestrator.getActiveAgentId());
    }
    publishReviewerPromptResult({
      output,
      threadId: threadId ?? undefined,
      effectiveState: deps.sessions.sessionManager.getEffectiveState(deps.context.userId),
      rotationNotice,
      artifact,
      sendToChat,
      sessionLogger: deps.observability.sessionLogger,
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendWorkspaceState: deps.transport.sendWorkspaceState,
      ws: deps.transport.ws,
      workspaceRoot: turnCwd,
    });
  } catch (error) {
    handlePromptError({
      error,
      aborted: controller.signal.aborted,
      sessionLogger: deps.observability.sessionLogger,
      logger: deps.observability.logger,
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      sendToChat,
      logPrefix: "Reviewer Prompt Error",
    });
  } finally {
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
  }

  return { handled: true, orchestrator };
}

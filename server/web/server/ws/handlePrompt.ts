import type { Input } from "../../../agents/protocol/types.js";

import { getHistoryClientMessageId } from "../../../utils/historyKind.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";
import { truncateForLog } from "../../utils.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { resolveWorkspaceStatePath } from "../../../workspace/adsPaths.js";
import { buildPromptInput, buildUserLogEntry, cleanupTempFiles } from "../../utils.js";
import { runAgentTurn } from "../../../agents/turn.js";
import { injectPlannerDraftSkill, parsePlannerDraftSlashCommand } from "../planner/draftSlashCommand.js";
import type { WsPromptHandlerDeps } from "./deps.js";
import { handlePlannerPromptOutput } from "../planner/plannerPromptHandler.js";
import { processScheduleOutput } from "../planner/scheduleHandler.js";
import { preferInMemoryThreadId } from "./threadIds.js";
import {
  buildHistoryInjectionDetails,
  prependContextToInput,
} from "./promptModelConfig.js";
import { applySessionOverrides } from "./sessionOverrides.js";
import { attachWorkerPromptHandler } from "./workerPromptHandler.js";
import { processPromptOutputBlocks } from "./promptOutputProcessing.js";
import { handlePromptError } from "./promptErrorHandling.js";
import { beginWsPromptRun, isWsPromptAbort, raceWsPromptAbort } from "./promptLifecycle.js";

export { buildHistoryInjectionContext, prependContextToInput } from "./promptModelConfig.js";
export { formatWriteExploredSummary } from "./workerPromptHandler.js";

export function excludeCurrentClientMessage(
  entries: HistoryEntry[],
  clientMessageId?: string | null,
): HistoryEntry[] {
  const normalized = String(clientMessageId ?? "").trim();
  if (!normalized) return entries;
  return entries.filter((entry) => getHistoryClientMessageId(entry.kind) !== normalized);
}

export async function handlePromptMessage(deps: WsPromptHandlerDeps): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (deps.request.parsed.type !== "prompt") {
    return { handled: false, orchestrator: deps.sessions.orchestrator };
  }

  const sendToChat = (payload: unknown): void => deps.transport.broadcastJson(payload);

  let orchestrator = deps.sessions.orchestrator;

  const workspaceRoot = detectWorkspaceFrom(deps.context.currentCwd);
  const lock = deps.sessions.getWorkspaceLock(workspaceRoot);

  await lock.runExclusive(async () => {
    const imageDir = resolveWorkspaceStatePath(workspaceRoot, "temp", "web-images");
    const promptInput = buildPromptInput(deps.request.parsed.payload, imageDir);
    if (!promptInput.ok) {
      deps.observability.sessionLogger?.logError(promptInput.message);
      deps.history.historyStore.add(deps.context.historyKey, {
        role: "status",
        text: promptInput.message,
        ts: Date.now(),
        kind: "error",
      });
      sendToChat({ type: "error", message: promptInput.message });
      return;
    }
    const tempAttachments = promptInput.attachments || [];
    const cleanupAttachments = () => cleanupTempFiles(tempAttachments);
    const userLogEntry = buildUserLogEntry(promptInput.input, deps.context.currentCwd);
    deps.observability.sessionLogger?.logInput(userLogEntry);
    const historyBeforeCurrentPrompt = deps.history.historyStore.get(deps.context.historyKey).slice();
    if (!deps.request.clientMessageId) {
      deps.history.historyStore.add(deps.context.historyKey, {
        role: "user",
        text: userLogEntry,
        ts: deps.request.receivedAt,
      });
    }

    let inputToSend: Input = promptInput.input;
    const isPlannerSession = deps.context.chatSessionId === "planner";
    const isWorkerSession = deps.context.chatSessionId === "main" || deps.context.chatSessionId === "worker";
    const shouldHandleTaskBundleDrafts = isPlannerSession || isWorkerSession;
    const isPlannerDraftCommand = isPlannerSession && Boolean(parsePlannerDraftSlashCommand(inputToSend));
    if (isPlannerDraftCommand) {
      inputToSend = injectPlannerDraftSkill(inputToSend);
    }
    const cleanupAfter = cleanupAttachments;
    const turnCwd = deps.context.currentCwd;

    const promptRun = beginWsPromptRun({
      historyKey: deps.context.historyKey,
      interruptControllers: deps.sessions.interruptControllers,
      promptRunEpochs: deps.sessions.promptRunEpochs,
    });
    const controller = promptRun.controller;
    orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, turnCwd, true);
    orchestrator.setWorkingDirectory(turnCwd);
    try {
      applySessionOverrides({
        sessionManager: deps.sessions.sessionManager,
        userId: deps.context.userId,
        payload: deps.request.parsed.payload,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.observability.sessionLogger?.logError(message);
      deps.observability.logger.warn(`[Prompt Override Error] ${message}`);
      deps.history.historyStore.add(deps.context.historyKey, {
        role: "status",
        text: message,
        ts: Date.now(),
        kind: "error",
      });
      sendToChat({ type: "error", message });
      promptRun.cleanup();
      cleanupAfter();
      return;
    }
    const status = orchestrator.status();
    if (!status.ready) {
      const message = status.error ?? "代理未启用，请配置凭证";
      deps.observability.sessionLogger?.logError(status.error ?? "代理未启用");
      deps.history.historyStore.add(deps.context.historyKey, {
        role: "status",
        text: message,
        ts: Date.now(),
        kind: "error",
      });
      sendToChat({ type: "error", message });
      promptRun.cleanup();
      cleanupAfter();
      return;
    }
    const { unsubscribe, handleExploredEntry } = attachWorkerPromptHandler({
      orchestrator,
      turnCwd,
      historyKey: deps.context.historyKey,
      historyStore: deps.history.historyStore,
      sendToChat,
      logger: deps.observability.logger,
      sessionLogger: deps.observability.sessionLogger,
      resolveAgentId: () => orchestrator.getActiveAgentId(),
      channel: "web",
      onSessionFallback: ({ previousSessionId, detail }) => {
        // This turn already ran without the old context; re-sending it now would
        // not put it back. Flag the *next* turn so the ADS history goes in then.
        const agentId = orchestrator.getActiveAgentId();
        deps.sessions.sessionManager.clearSavedThreadId?.(deps.context.userId, agentId);
        deps.sessions.sessionManager.markHistoryInjection(deps.context.userId);
        deps.observability.logger.warn(
          `[ContextRestore] native resume failed user=${deps.context.userId} agent=${agentId} session=${previousSessionId}; next turn will inject history. detail=${truncateForLog(detail)}`,
        );
        deps.history.historyStore.add(deps.context.historyKey, {
          role: "status",
          text: "原生会话已不存在，已改用新会话；下一轮将带上最近聊天历史。",
          ts: Date.now(),
          kind: "status",
        });
      },
      onThreadStarted: (threadId) => {
        const activeAgentId = orchestrator.getActiveAgentId();
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, activeAgentId);
        if (typeof deps.history.historyStore.linkAgentSession === "function") {
          deps.history.historyStore.linkAgentSession(deps.context.historyKey, {
            agentId: activeAgentId,
            providerSessionId: threadId,
            cwd: turnCwd,
          });
        }
      },
    });
    let agentTurnPromise: Promise<Awaited<ReturnType<typeof runAgentTurn>>> | undefined;

    try {
      const activeAgentId = orchestrator.getActiveAgentId();
      const savedThreadId = deps.sessions.sessionManager.getSavedThreadId(deps.context.userId, activeAgentId);
      // Prefer the in-memory thread id as the "expected" value for this request. Using the persisted
      // value directly can produce false positives if another connection/process updated storage.
      const expectedThreadId =
        preferInMemoryThreadId({ inMemoryThreadId: orchestrator.getThreadId(), savedThreadId }) ?? undefined;
      if (expectedThreadId && typeof deps.history.historyStore.linkAgentSession === "function") {
        deps.history.historyStore.linkAgentSession(deps.context.historyKey, {
          agentId: activeAgentId,
          providerSessionId: expectedThreadId,
          cwd: turnCwd,
        });
      }

      let effectiveInput: Input = inputToSend;
      if (deps.sessions.sessionManager.needsHistoryInjection(deps.context.userId)) {
        const historyEntries = excludeCurrentClientMessage(
          historyBeforeCurrentPrompt,
          deps.request.clientMessageId,
        );
        const injectionDetails = buildHistoryInjectionDetails(historyEntries);
        if (injectionDetails) {
          effectiveInput = prependContextToInput(injectionDetails.text, inputToSend);
          deps.observability.logger.info(
            `[ContextRestore] Injected ${injectionDetails.entryCount} history entries (unanswered=${injectionDetails.unansweredCount}) for user=${deps.context.userId} session=${deps.context.sessionId}`,
          );
          sendToChat({
            type: "context_injection",
            entryCount: injectionDetails.entryCount,
            earliestTs: injectionDetails.earliestTs,
            latestTs: injectionDetails.latestTs,
            clientMessageId: deps.request.clientMessageId ?? undefined,
            ts: Date.now(),
          });
        }
        deps.sessions.sessionManager.clearHistoryInjection(deps.context.userId);
      }

      agentTurnPromise = runAgentTurn(orchestrator, effectiveInput, {
        streaming: true,
        signal: controller.signal,
        onExploredEntry: handleExploredEntry,
        cwd: turnCwd,
        workspaceRoot,
        historySessionId: deps.context.historyKey,
      });
      const result = await raceWsPromptAbort({
        controller,
        runPromise: agentTurnPromise,
      });
      promptRun.ensureActive();

      const workspaceRootForAdr = workspaceRoot;
      const { outputToSend } = await processPromptOutputBlocks({
        rawResponse: result.response,
        workspaceRoot: workspaceRootForAdr,
      });
      promptRun.ensureActive();
      let threadId = orchestrator.getThreadId();
      let threadReset = Boolean(expectedThreadId) && Boolean(threadId) && expectedThreadId !== threadId;
      let outputForChat = outputToSend;

      if (shouldHandleTaskBundleDrafts) {
        const plannerHandled = await handlePlannerPromptOutput({
          outputToSend,
          userLogEntry,
          requestId: deps.request.requestId,
          clientMessageId: deps.request.clientMessageId,
          authUserId: deps.context.authUserId,
          chatSessionId: deps.context.chatSessionId,
          historyKey: deps.context.historyKey,
          workspaceRoot: workspaceRootForAdr,
          orchestrator,
          expectedThreadId,
          logger: deps.observability.logger,
          sendToChat,
          ensureTaskContext: deps.tasks.ensureTaskContext,
          promoteQueuedTasksToPending: deps.tasks.promoteQueuedTasksToPending,
          broadcastToSession: deps.tasks.broadcastToSession,
          scheduleCompiler: deps.scheduler.scheduleCompiler,
          scheduler: deps.scheduler.scheduler,
          scheduleSource: deps.context.chatSessionId || "worker",
          draftCommand: isPlannerDraftCommand,
        });
        promptRun.ensureActive();
        outputForChat = plannerHandled.outputForChat;
        threadId = plannerHandled.threadId;
        threadReset = plannerHandled.threadReset;
      } else {
        outputForChat = await processScheduleOutput({
          outputForChat,
          isDraftCommand: false,
          workspaceRoot: workspaceRootForAdr,
          scheduleCompiler: deps.scheduler.scheduleCompiler,
          scheduler: deps.scheduler.scheduler,
          logger: deps.observability.logger,
          source: deps.context.chatSessionId || "worker",
        });
        promptRun.ensureActive();
      }

      promptRun.ensureActive();
      if (threadId) {
        const activeAgentId = orchestrator.getActiveAgentId();
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, activeAgentId);
        if (typeof deps.history.historyStore.linkAgentSession === "function") {
          deps.history.historyStore.linkAgentSession(deps.context.historyKey, {
            agentId: activeAgentId,
            providerSessionId: threadId,
            cwd: turnCwd,
          });
        }
      }
      const effectiveState = deps.sessions.sessionManager.getEffectiveState(deps.context.userId);
      if (deps.request.clientMessageId && typeof deps.history.historyStore.updatePromptExecutionMetadata === "function") {
        try {
          deps.history.historyStore.updatePromptExecutionMetadata(
            deps.context.historyKey,
            deps.request.clientMessageId,
            {
              effectiveAgentId: effectiveState.activeAgentId,
              effectiveModel: effectiveState.model,
              effectiveModelReasoningEffort: effectiveState.modelReasoningEffort,
            },
          );
        } catch (error) {
          deps.observability.logger.warn(
            `[Prompt] Failed to persist effective execution metadata: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      sendToChat({
        type: "result",
        ok: true,
        output: outputForChat,
        threadId,
        expectedThreadId,
        threadReset,
        contextMode: threadReset ? "history_injection" : undefined,
        effectiveModel: effectiveState.model,
        effectiveModelReasoningEffort: effectiveState.modelReasoningEffort,
        activeAgentId: effectiveState.activeAgentId,
      });
      if (deps.observability.sessionLogger) {
        deps.observability.sessionLogger.attachThreadId(threadId ?? undefined);
        deps.observability.sessionLogger.logOutput(outputForChat);
      }
      deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: outputForChat, ts: Date.now() });
      if (threadReset) {
        deps.sessions.sessionManager.markHistoryInjection(deps.context.userId);
      }
      if (deps.transport.broadcastWorkspaceState) {
        deps.transport.broadcastWorkspaceState(turnCwd);
      } else {
        deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
      }
    } catch (error) {
      if (isWsPromptAbort(error)) {
        const activePromise = typeof agentTurnPromise !== "undefined" ? agentTurnPromise : undefined;
        if (activePromise) {
          void activePromise.catch((innerError) => {
            const detail = innerError instanceof Error ? innerError.message : String(innerError);
            deps.observability.logger.debug(`[Web] prompt settled after abort: ${detail}`);
          });
        }
      }
      handlePromptError({
        error,
        aborted: controller.signal.aborted || isWsPromptAbort(error),
        sessionLogger: deps.observability.sessionLogger,
        logger: deps.observability.logger,
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        sendToChat,
      });
    } finally {
      unsubscribe();
      promptRun.cleanup();
      cleanupAfter();
    }
  });

  return { handled: true, orchestrator };
}

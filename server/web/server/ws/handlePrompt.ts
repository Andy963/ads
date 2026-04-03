import type { Input } from "../../../agents/protocol/types.js";

import type { ExploredEntry } from "../../../utils/activityTracker.js";
import { truncateForLog } from "../../utils.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { resolveWorkspaceStatePath } from "../../../workspace/adsPaths.js";
import { buildPromptInput, buildUserLogEntry, cleanupTempFiles } from "../../utils.js";
import { runCollaborativeTurn } from "../../../agents/hub.js";
import { injectPlannerDraftSkill, parsePlannerDraftSlashCommand } from "../planner/draftSlashCommand.js";
import type { WsPromptHandlerDeps } from "./deps.js";
import { handlePlannerPromptOutput } from "../planner/plannerPromptHandler.js";
import { processScheduleOutput } from "../planner/scheduleHandler.js";
import { preferInMemoryThreadId } from "./threadIds.js";
import {
  buildHistoryInjectionContext,
  prependContextToInput,
} from "./promptModelConfig.js";
import { applySessionOverrides } from "./sessionOverrides.js";
import { attachWorkerPromptHandler } from "./workerPromptHandler.js";
import { handleReviewerPromptMessage } from "./reviewerPrompt.js";
import { createDelegationTracker } from "./delegationTracker.js";
import { processPromptOutputBlocks } from "./promptOutputProcessing.js";
import { handlePromptError } from "./promptErrorHandling.js";
import { beginWsPromptRun, isWsPromptAbort, raceWsPromptAbort } from "./promptLifecycle.js";
import { shouldResumeMissingRuntimeSession } from "./resumeThreadFallback.js";

export { buildHistoryInjectionContext, prependContextToInput } from "./promptModelConfig.js";
export { formatWriteExploredSummary } from "./workerPromptHandler.js";

export async function handlePromptMessage(deps: WsPromptHandlerDeps): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (deps.request.parsed.type !== "prompt") {
    return { handled: false, orchestrator: deps.sessions.orchestrator };
  }

  const sendToClient = (payload: unknown): void => deps.transport.safeJsonSend(deps.transport.ws, payload);
  const sendToChat = (payload: unknown): void => deps.transport.broadcastJson(payload);

  let orchestrator = deps.sessions.orchestrator;

  const workspaceRoot = detectWorkspaceFrom(deps.context.currentCwd);
  const lock = deps.sessions.getWorkspaceLock(workspaceRoot);

  await lock.runExclusive(async () => {
    const imageDir = resolveWorkspaceStatePath(workspaceRoot, "temp", "web-images");
    const promptInput = buildPromptInput(deps.request.parsed.payload, imageDir);
    if (!promptInput.ok) {
      deps.observability.sessionLogger?.logError(promptInput.message);
      sendToClient({ type: "error", message: promptInput.message });
      return;
    }
    const tempAttachments = promptInput.attachments || [];
    const cleanupAttachments = () => cleanupTempFiles(tempAttachments);
    const userLogEntry = buildUserLogEntry(promptInput.input, deps.context.currentCwd);
    deps.observability.sessionLogger?.logInput(userLogEntry);
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
    const reviewerResult = await handleReviewerPromptMessage({
      deps,
      workspaceRoot,
      turnCwd,
      inputToSend,
      controller,
      promptRun,
      sendToClient,
      sendToChat,
      cleanupAfter,
    });
    if (reviewerResult.handled) {
      orchestrator = reviewerResult.orchestrator;
      return;
    }
    orchestrator = deps.sessions.sessionManager.getOrCreate(
      deps.context.userId,
      turnCwd,
      shouldResumeMissingRuntimeSession(deps.sessions.sessionManager, deps.context.userId),
    );
    const status = orchestrator.status();
    if (!status.ready) {
      deps.observability.sessionLogger?.logError(status.error ?? "代理未启用");
      sendToClient({ type: "error", message: status.error ?? "代理未启用，请配置凭证" });
      promptRun.cleanup();
      cleanupAfter();
      return;
    }
    orchestrator.setWorkingDirectory(turnCwd);
    const { notice: rotationNotice } = applySessionOverrides({
      sessionManager: deps.sessions.sessionManager,
      userId: deps.context.userId,
      payload: deps.request.parsed.payload,
    });
    const { unsubscribe, handleExploredEntry } = attachWorkerPromptHandler({
      orchestrator,
      turnCwd,
      historyKey: deps.context.historyKey,
      historyStore: deps.history.historyStore,
      sendToChat,
      logger: deps.observability.logger,
      sessionLogger: deps.observability.sessionLogger,
    });
    let collaborativeTurnPromise: Promise<Awaited<ReturnType<typeof runCollaborativeTurn>>> | undefined;

    try {
      const activeAgentId = orchestrator.getActiveAgentId();
      const savedThreadId = deps.sessions.sessionManager.getSavedThreadId(deps.context.userId, activeAgentId);
      // Prefer the in-memory thread id as the "expected" value for this request. Using the persisted
      // value directly can produce false positives if another connection/process updated storage.
      const expectedThreadId =
        preferInMemoryThreadId({ inMemoryThreadId: orchestrator.getThreadId(), savedThreadId }) ?? undefined;

      const delegationTracker = createDelegationTracker();

      let effectiveInput: Input = inputToSend;
      if (deps.sessions.sessionManager.needsHistoryInjection(deps.context.userId)) {
        const historyEntries = deps.history.historyStore
          .get(deps.context.historyKey)
          .filter((entry) => entry.ts <= deps.request.receivedAt);
        const injectionContext = buildHistoryInjectionContext(historyEntries);
        if (injectionContext) {
          effectiveInput = prependContextToInput(injectionContext, inputToSend);
          deps.observability.logger.info(
            `[ContextRestore] Injected ${historyEntries.length} history entries for user=${deps.context.userId} session=${deps.context.sessionId}`,
          );
        }
        deps.sessions.sessionManager.clearHistoryInjection(deps.context.userId);
      }

      collaborativeTurnPromise = runCollaborativeTurn(orchestrator, effectiveInput, {
        streaming: true,
        signal: controller.signal,
        onExploredEntry: handleExploredEntry,
        hooks: {
          onSupervisorRound: (round, directives) =>
            deps.observability.logger.info(`[Auto] supervisor round=${round} directives=${directives}`),
          onDelegationStart: ({ agentId, agentName, prompt }) => {
            deps.observability.logger.info(`[Auto] invoke ${agentName} (${agentId}): ${truncateForLog(prompt)}`);
            // The LiveActivity UI is intentionally short-lived (TTL). Emit a structured message so
            // the frontend can keep a persistent "agents in progress" indicator while delegations run.
            const delegationId = delegationTracker.stash(agentId, prompt);
            sendToChat({
              type: "agent",
              event: "delegation:start",
              delegationId,
              agentId,
              agentName,
              prompt: truncateForLog(prompt, 200),
              ts: Date.now(),
            });
            handleExploredEntry({
              category: "Agent",
              summary: `${agentName}（${agentId}）在后台执行：${truncateForLog(prompt, 140)}`,
              ts: Date.now(),
              source: "tool_hook",
            } as ExploredEntry);
          },
          onDelegationResult: (summary) => {
            deps.observability.logger.info(
              `[Auto] done ${summary.agentName} (${summary.agentId}): ${truncateForLog(summary.prompt)}`,
            );
            const delegationId = delegationTracker.pop(summary.agentId, summary.prompt);
            sendToChat({
              type: "agent",
              event: "delegation:result",
              delegationId,
              agentId: summary.agentId,
              agentName: summary.agentName,
              prompt: truncateForLog(summary.prompt, 200),
              ts: Date.now(),
            });
            handleExploredEntry({
              category: "Agent",
              summary: `✓ ${summary.agentName} 完成：${truncateForLog(summary.prompt, 140)}`,
              ts: Date.now(),
              source: "tool_hook",
            } as ExploredEntry);
          },
        },
        cwd: turnCwd,
        historyNamespace: "web",
        historySessionId: deps.context.historyKey,
      });
      const result = await raceWsPromptAbort({
        controller,
        runPromise: collaborativeTurnPromise,
      });
      promptRun.ensureActive();

      const workspaceRootForAdr = detectWorkspaceFrom(turnCwd);
      const { finalOutput, outputToSend, createdSpecRefs } = await processPromptOutputBlocks({
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
          finalOutput,
          createdSpecRefs,
          userLogEntry,
          requestId: deps.request.requestId,
          clientMessageId: deps.request.clientMessageId,
          authUserId: deps.context.authUserId,
          chatSessionId: deps.context.chatSessionId,
          historyKey: deps.context.historyKey,
          workspaceRoot: workspaceRootForAdr,
          turnCwd,
          controller,
          orchestrator,
          expectedThreadId,
          logger: deps.observability.logger,
          sendToChat,
          handleExploredEntry,
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
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, orchestrator.getActiveAgentId());
      }
      const effectiveState = deps.sessions.sessionManager.getEffectiveState(deps.context.userId);
      sendToChat({
        type: "result",
        ok: true,
        output: outputForChat,
        threadId,
        expectedThreadId,
        threadReset,
        effectiveModel: effectiveState.model,
        effectiveModelReasoningEffort: effectiveState.modelReasoningEffort,
        activeAgentId: effectiveState.activeAgentId,
        notice: rotationNotice,
      });
      if (deps.observability.sessionLogger) {
        deps.observability.sessionLogger.attachThreadId(threadId ?? undefined);
        deps.observability.sessionLogger.logOutput(outputForChat);
      }
      deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: outputForChat, ts: Date.now() });
      deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    } catch (error) {
      if (isWsPromptAbort(error)) {
        const activePromise = typeof collaborativeTurnPromise !== "undefined" ? collaborativeTurnPromise : undefined;
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

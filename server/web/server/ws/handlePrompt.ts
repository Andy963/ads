import type { Input } from "../../../agents/protocol/types.js";

import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";
import { processSpecBlocks } from "../../../utils/specRecording.js";
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
import {
  buildHistoryInjectionContext,
  parseModelFromPayload,
  parseModelReasoningEffortFromPayload,
  prependContextToInput,
} from "./promptModelConfig.js";
import { attachWorkerPromptHandler } from "./workerPromptHandler.js";

export { buildHistoryInjectionContext, prependContextToInput } from "./promptModelConfig.js";
export { formatWriteExploredSummary } from "./workerPromptHandler.js";

export async function handlePromptMessage(deps: WsPromptHandlerDeps): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (deps.request.parsed.type !== "prompt") {
    return { handled: false, orchestrator: deps.sessions.orchestrator };
  }

  if (deps.context.chatSessionId === "reviewer") {
    deps.transport.safeJsonSend(deps.transport.ws, {
      type: "error",
      message: "Reviewer lane is read-only. It only consumes immutable snapshots from the review queue.",
    });
    return { handled: true, orchestrator: deps.sessions.orchestrator };
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
    const isPlannerDraftCommand =
      deps.context.chatSessionId === "planner" && Boolean(parsePlannerDraftSlashCommand(inputToSend));
    if (isPlannerDraftCommand) {
      inputToSend = injectPlannerDraftSkill(inputToSend);
    }
    const cleanupAfter = cleanupAttachments;
    const turnCwd = deps.context.currentCwd;

    const controller = new AbortController();
    deps.sessions.interruptControllers.set(deps.context.historyKey, controller);
    orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, turnCwd);
    const status = orchestrator.status();
    if (!status.ready) {
      deps.observability.sessionLogger?.logError(status.error ?? "代理未启用");
      sendToClient({ type: "error", message: status.error ?? "代理未启用，请配置凭证" });
      deps.sessions.interruptControllers.delete(deps.context.historyKey);
      cleanupAfter();
      return;
    }
    orchestrator.setWorkingDirectory(turnCwd);
    const modelOverride = parseModelFromPayload(deps.request.parsed.payload);
    if (modelOverride.present) {
      orchestrator.setModel(modelOverride.model);
    }
    const reasoningEffort = parseModelReasoningEffortFromPayload(deps.request.parsed.payload);
    if (reasoningEffort.present) {
      orchestrator.setModelReasoningEffort(reasoningEffort.effort);
    }
    const { unsubscribe, handleExploredEntry } = attachWorkerPromptHandler({
      orchestrator,
      turnCwd,
      historyKey: deps.context.historyKey,
      historyStore: deps.history.historyStore,
      sendToChat,
      logger: deps.observability.logger,
      sessionLogger: deps.observability.sessionLogger,
    });

    try {
      const expectedThreadId = deps.sessions.sessionManager.getSavedThreadId(
        deps.context.userId,
        orchestrator.getActiveAgentId(),
      );

      const delegationIdsByFingerprint = new Map<string, string[]>();
      const delegationFingerprint = (agentId: string, prompt: string): string =>
        `${String(agentId ?? "").trim().toLowerCase()}:${truncateForLog(prompt, 200)}`;
      const nextDelegationId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stashDelegationId = (agentId: string, prompt: string): string => {
        const fp = delegationFingerprint(agentId, prompt);
        const next = delegationIdsByFingerprint.get(fp) ?? [];
        const id = nextDelegationId();
        delegationIdsByFingerprint.set(fp, [...next, id]);
        return id;
      };
      const popDelegationId = (agentId: string, prompt: string): string => {
        const fp = delegationFingerprint(agentId, prompt);
        const existing = delegationIdsByFingerprint.get(fp) ?? [];
        if (existing.length === 0) {
          return nextDelegationId();
        }
        const [head, ...tail] = existing;
        if (tail.length > 0) delegationIdsByFingerprint.set(fp, tail);
        else delegationIdsByFingerprint.delete(fp);
        return head!;
      };

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

      const result = await runCollaborativeTurn(orchestrator, effectiveInput, {
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
            const delegationId = stashDelegationId(agentId, prompt);
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
            const delegationId = popDelegationId(summary.agentId, summary.prompt);
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

      const rawResponse = typeof result.response === "string" ? result.response : String(result.response ?? "");
      const finalOutput = stripLeadingTranslation(rawResponse);
      const workspaceRootForAdr = detectWorkspaceFrom(turnCwd);
      let outputToSend = finalOutput;
      let createdSpecRefs: string[] = [];
      try {
        const adrProcessed = processAdrBlocks(outputToSend, workspaceRootForAdr);
        outputToSend = adrProcessed.finalText || outputToSend;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputToSend = `${outputToSend}\n\n---\nADR warning: failed to record ADR (${message})`;
      }
      try {
        const specProcessed = await processSpecBlocks(outputToSend, workspaceRootForAdr);
        outputToSend = specProcessed.finalText || outputToSend;
        createdSpecRefs = specProcessed.results.map((r) => r.specRef);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputToSend = `${outputToSend}\n\n---\nSpec warning: failed to record spec (${message})`;
      }
      let threadId = orchestrator.getThreadId();
      let threadReset = Boolean(expectedThreadId) && Boolean(threadId) && expectedThreadId !== threadId;
      let outputForChat = outputToSend;

      if (deps.context.chatSessionId === "planner") {
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
          draftCommand: isPlannerDraftCommand,
        });
        outputForChat = plannerHandled.outputForChat;
        threadId = plannerHandled.threadId;
        threadReset = plannerHandled.threadReset;
      }

      sendToChat({ type: "result", ok: true, output: outputForChat, threadId, expectedThreadId, threadReset });
      if (deps.observability.sessionLogger) {
        deps.observability.sessionLogger.attachThreadId(threadId ?? undefined);
        deps.observability.sessionLogger.logOutput(outputForChat);
      }
      deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: outputForChat, ts: Date.now() });

      if (threadId) {
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, orchestrator.getActiveAgentId());
      }
      deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        sendToChat({ type: "error", message: "已中断，输出可能不完整" });
      } else {
        const errorInfo: CodexErrorInfo =
          error instanceof CodexClassifiedError
            ? error.info
            : classifyError(error);

        const logMessage = `[${errorInfo.code}] ${errorInfo.message}`;
        const stack = error instanceof Error ? error.stack : undefined;
        deps.observability.sessionLogger?.logError(stack ? `${logMessage}\n${stack}` : logMessage);
        deps.observability.logger.warn(
          `[Prompt Error] code=${errorInfo.code} retryable=${errorInfo.retryable} needsReset=${errorInfo.needsReset} message=${errorInfo.message}`,
        );

        deps.history.historyStore.add(deps.context.historyKey, {
          role: "status",
          text: `[${errorInfo.code}] ${errorInfo.userHint}`,
          ts: Date.now(),
          kind: "error",
        });

        sendToChat({
          type: "error",
          message: errorInfo.userHint,
          errorInfo: {
            code: errorInfo.code,
            retryable: errorInfo.retryable,
            needsReset: errorInfo.needsReset,
            originalError: errorInfo.originalError,
          },
        });
      }
    } finally {
      unsubscribe();
      deps.sessions.interruptControllers.delete(deps.context.historyKey);
      cleanupAfter();
    }
  });

  return { handled: true, orchestrator };
}

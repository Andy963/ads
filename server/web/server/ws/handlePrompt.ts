import type { Input } from "../../../agents/protocol/types.js";

import type { AgentEvent } from "../../../codex/events.js";
import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";
import { processSpecBlocks } from "../../../utils/specRecording.js";
import type { ExploredEntry } from "../../../utils/activityTracker.js";
import { truncateForLog } from "../../utils.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { resolveWorkspaceStatePath } from "../../../workspace/adsPaths.js";
import { buildPromptInput, buildUserLogEntry, cleanupTempFiles } from "../../utils.js";
import { runCollaborativeTurn } from "../../../agents/hub.js";
import type { WsMessage } from "./schema.js";
import { injectPlannerDraftSkill, parsePlannerDraftSlashCommand } from "../planner/draftSlashCommand.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import type { ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
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

export async function handlePromptMessage(deps: {
  parsed: WsMessage;
  ws: import("ws").WebSocket;
  safeJsonSend: (ws: import("ws").WebSocket, payload: unknown) => void;
  broadcastJson: (payload: unknown) => void;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
  sessionLogger: {
    logInput: (text: string) => void;
    logOutput: (text: string) => void;
    logError: (text: string) => void;
    logEvent: (event: AgentEvent) => void;
    attachThreadId: (threadId?: string) => void;
  } | null;
  requestId: string;
  clientMessageId: string | null;
  traceWsDuplication: boolean;
  receivedAt: number;
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  userId: number;
  historyKey: string;
  currentCwd: string;
  allowedDirs: string[];
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  interruptControllers: Map<string, AbortController>;
  historyStore: HistoryStore;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  sendWorkspaceState: (ws: import("ws").WebSocket, workspaceRoot: string) => void;
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending?: (ctx: TaskQueueContext) => void;
  broadcastToSession?: (sessionId: string, payload: unknown) => void;
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (deps.parsed.type !== "prompt") {
    return { handled: false, orchestrator: deps.orchestrator };
  }

  if (deps.chatSessionId === "reviewer") {
    deps.safeJsonSend(deps.ws, { type: "error", message: "Reviewer lane is read-only. It only consumes immutable snapshots from the review queue." });
    return { handled: true, orchestrator: deps.orchestrator };
  }

  const sendToClient = (payload: unknown): void => deps.safeJsonSend(deps.ws, payload);
  const sendToChat = (payload: unknown): void => deps.broadcastJson(payload);

  let orchestrator = deps.orchestrator;

  const workspaceRoot = detectWorkspaceFrom(deps.currentCwd);
  const lock = deps.getWorkspaceLock(workspaceRoot);

  await lock.runExclusive(async () => {
    const imageDir = resolveWorkspaceStatePath(workspaceRoot, "temp", "web-images");
    const promptInput = buildPromptInput(deps.parsed.payload, imageDir);
    if (!promptInput.ok) {
      deps.sessionLogger?.logError(promptInput.message);
      sendToClient({ type: "error", message: promptInput.message });
      return;
    }
    const tempAttachments = promptInput.attachments || [];
    const cleanupAttachments = () => cleanupTempFiles(tempAttachments);
    const userLogEntry = buildUserLogEntry(promptInput.input, deps.currentCwd);
    deps.sessionLogger?.logInput(userLogEntry);
    if (!deps.clientMessageId) {
      deps.historyStore.add(deps.historyKey, {
        role: "user",
        text: userLogEntry,
        ts: deps.receivedAt,
      });
    }

    let inputToSend: Input = promptInput.input;
    const isPlannerDraftCommand = deps.chatSessionId === "planner" && Boolean(parsePlannerDraftSlashCommand(inputToSend));
    if (isPlannerDraftCommand) {
      inputToSend = injectPlannerDraftSkill(inputToSend);
    }
    const cleanupAfter = cleanupAttachments;
    const turnCwd = deps.currentCwd;

    const controller = new AbortController();
    deps.interruptControllers.set(deps.historyKey, controller);
    orchestrator = deps.sessionManager.getOrCreate(deps.userId, turnCwd);
    const status = orchestrator.status();
    if (!status.ready) {
      deps.sessionLogger?.logError(status.error ?? "代理未启用");
      sendToClient({ type: "error", message: status.error ?? "代理未启用，请配置凭证" });
      deps.interruptControllers.delete(deps.historyKey);
      cleanupAfter();
      return;
    }
    orchestrator.setWorkingDirectory(turnCwd);
    const modelOverride = parseModelFromPayload(deps.parsed.payload);
    if (modelOverride.present) {
      orchestrator.setModel(modelOverride.model);
    }
    const reasoningEffort = parseModelReasoningEffortFromPayload(deps.parsed.payload);
    if (reasoningEffort.present) {
      orchestrator.setModelReasoningEffort(reasoningEffort.effort);
    }
    const { unsubscribe, handleExploredEntry } = attachWorkerPromptHandler({
      orchestrator,
      turnCwd,
      historyKey: deps.historyKey,
      historyStore: deps.historyStore,
      sendToChat,
      logger: deps.logger,
      sessionLogger: deps.sessionLogger,
    });

    try {
      const expectedThreadId = deps.sessionManager.getSavedThreadId(deps.userId, orchestrator.getActiveAgentId());

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
      if (deps.sessionManager.needsHistoryInjection(deps.userId)) {
        const historyEntries = deps.historyStore.get(deps.historyKey).filter((entry) => entry.ts <= deps.receivedAt);
        const injectionContext = buildHistoryInjectionContext(historyEntries);
        if (injectionContext) {
          effectiveInput = prependContextToInput(injectionContext, inputToSend);
          deps.logger.info(
            `[ContextRestore] Injected ${historyEntries.length} history entries for user=${deps.userId} session=${deps.sessionId}`,
          );
        }
        deps.sessionManager.clearHistoryInjection(deps.userId);
      }

      const result = await runCollaborativeTurn(orchestrator, effectiveInput, {
        streaming: true,
        signal: controller.signal,
        onExploredEntry: handleExploredEntry,
        hooks: {
          onSupervisorRound: (round, directives) => deps.logger.info(`[Auto] supervisor round=${round} directives=${directives}`),
          onDelegationStart: ({ agentId, agentName, prompt }) => {
            deps.logger.info(`[Auto] invoke ${agentName} (${agentId}): ${truncateForLog(prompt)}`);
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
            deps.logger.info(`[Auto] done ${summary.agentName} (${summary.agentId}): ${truncateForLog(summary.prompt)}`);
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
        historySessionId: deps.historyKey,
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

      if (deps.chatSessionId === "planner") {
        const plannerHandled = await handlePlannerPromptOutput({
          outputToSend,
          finalOutput,
          createdSpecRefs,
          userLogEntry,
          requestId: deps.requestId,
          clientMessageId: deps.clientMessageId,
          authUserId: deps.authUserId,
          chatSessionId: deps.chatSessionId,
          historyKey: deps.historyKey,
          workspaceRoot: workspaceRootForAdr,
          turnCwd,
          controller,
          orchestrator,
          expectedThreadId,
          logger: deps.logger,
          sendToChat,
          handleExploredEntry,
          ensureTaskContext: deps.ensureTaskContext,
          promoteQueuedTasksToPending: deps.promoteQueuedTasksToPending,
          broadcastToSession: deps.broadcastToSession,
          scheduleCompiler: deps.scheduleCompiler,
          scheduler: deps.scheduler,
          draftCommand: isPlannerDraftCommand,
        });
        outputForChat = plannerHandled.outputForChat;
        threadId = plannerHandled.threadId;
        threadReset = plannerHandled.threadReset;
      }

      sendToChat({ type: "result", ok: true, output: outputForChat, threadId, expectedThreadId, threadReset });
      if (deps.sessionLogger) {
        deps.sessionLogger.attachThreadId(threadId ?? undefined);
        deps.sessionLogger.logOutput(outputForChat);
      }
      deps.historyStore.add(deps.historyKey, { role: "ai", text: outputForChat, ts: Date.now() });

      if (threadId) {
        deps.sessionManager.saveThreadId(deps.userId, threadId, orchestrator.getActiveAgentId());
      }
      deps.sendWorkspaceState(deps.ws, turnCwd);
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
        deps.sessionLogger?.logError(stack ? `${logMessage}\n${stack}` : logMessage);
        deps.logger.warn(`[Prompt Error] code=${errorInfo.code} retryable=${errorInfo.retryable} needsReset=${errorInfo.needsReset} message=${errorInfo.message}`);

        deps.historyStore.add(deps.historyKey, {
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
      deps.interruptControllers.delete(deps.historyKey);
      cleanupAfter();
    }
  });

  return { handled: true, orchestrator };
}

import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { SessionManager } from "../../../sessions/sessionManager.js";
import { isNativeExecutionId } from "../../../runtime/sessionIdentity.js";
import { DEFAULT_AGENT_RUNTIME } from "../../../runtime/config.js";
import { areSessionCwdsCompatible } from "../../../sessions/sessionState.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";
import { truncateForLog } from "../../utils.js";
import type {
  WsTaskResumeHandlerDeps,
} from "./deps.js";
import {
  buildHistoryStoreResumeTranscript,
} from "./taskResumeConversation.js";
import { assertSessionResumable } from "./taskResumeProbe.js";
import { sendTaskResumeHistorySnapshot } from "./taskResumeHistory.js";
import { resolveHistoryOwnerId } from "./connectionIdentity.js";
import {
  isPermanentTaskResumeFailure,
  parseTaskResumeRequest,
  selectTaskResumeThread,
} from "./taskResume.js";

function cloneHistoryEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

const CLIENT_MESSAGE_ID_KIND_PREFIX = "client_message_id:";

/**
 * Restored rows land in another lane's history, where the source prompt id is
 * meaningless: keeping it makes the target's unique client-message index drop
 * the row without an error. Prompt metadata after the id is still worth keeping.
 */
function withoutClientMessageId(entry: HistoryEntry): HistoryEntry {
  const kind = String(entry.kind ?? "").trim();
  if (!kind.startsWith(CLIENT_MESSAGE_ID_KIND_PREFIX)) {
    return entry;
  }
  const separator = kind.indexOf(";");
  const metadata = separator >= 0 ? kind.slice(separator + 1).trim() : "";
  return metadata ? { ...entry, kind: metadata } : { role: entry.role, text: entry.text, ts: entry.ts };
}

function historyEntryIdentity(entry: HistoryEntry): string {
  return `${entry.role}\u0000${entry.ts}\u0000${entry.text}`;
}

/**
 * Copies a selected conversation into the active lane. Entries already present
 * in the target are skipped, so restoring a lane into itself or restoring the
 * same source twice cannot duplicate the transcript. A divider is only written
 * when something was actually appended: an empty divider would hide the lane's
 * existing turns from later resume transcripts.
 */
function buildRestoredHistory(args: {
  previousEntries: readonly HistoryEntry[];
  selectedEntries: readonly HistoryEntry[];
  statusText: string;
}): HistoryEntry[] {
  const dividerIndex = args.selectedEntries
    .map((entry) => entry.kind)
    .lastIndexOf("session_divider");
  const conversation = args.selectedEntries.slice(dividerIndex + 1);
  const seen = new Set(args.previousEntries.map(historyEntryIdentity));
  const copies: HistoryEntry[] = [];
  for (const entry of conversation) {
    const identity = historyEntryIdentity(entry);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    copies.push(withoutClientMessageId(entry));
  }

  const restored = cloneHistoryEntries(args.previousEntries);
  if (copies.length > 0) {
    restored.push({
      role: "status",
      text: "Selected conversation restored from ADS history.",
      ts: Date.now(),
      kind: "session_divider",
    });
    restored.push(...copies);
  }
  restored.push({ role: "status", text: args.statusText, ts: Date.now() });
  return restored;
}

/** The unified runtime's provider-native session is a Codex thread. */
const NATIVE_RESUME_AGENTS = new Set(["codex"]);

function supportsNativeResume(agentId: string | undefined): boolean {
  return NATIVE_RESUME_AGENTS.has(String(agentId ?? "").trim());
}

/**
 * Why an attempted native resume did not happen. Falling back to history
 * injection reads identically to never having had a native session, which hides
 * the one fact worth acting on: the provider-side transcript is gone.
 */
function describeNativeResumeFailure(agentId: string, message: string): string {
  if (!supportsNativeResume(agentId)) {
    return `${agentId} 不支持原生会话恢复`;
  }
  if (isPermanentTaskResumeFailure(message)) {
    return "会话文件已不存在";
  }
  return "恢复出错";
}

function replaceHistoryEntries(args: {
  historyStore: Pick<WsTaskResumeHandlerDeps["history"]["historyStore"], "clear" | "add">;
  historyKey: string;
  entries: readonly HistoryEntry[];
}): void {
  args.historyStore.clear(args.historyKey);
  for (const entry of args.entries) {
    args.historyStore.add(args.historyKey, entry);
  }
}

function commitTaskResumeHistory(args: {
  historyStore: Pick<WsTaskResumeHandlerDeps["history"]["historyStore"], "clear" | "add">;
  historyKey: string;
  previousEntries: readonly HistoryEntry[];
  statusText: string;
}): void {
  const originalEntries = cloneHistoryEntries(args.previousEntries);
  const resumedEntries = [
    ...cloneHistoryEntries(args.previousEntries),
    {
      role: "status",
      text: args.statusText,
      ts: Date.now(),
    },
  ];

  try {
    replaceHistoryEntries({
      historyStore: args.historyStore,
      historyKey: args.historyKey,
      entries: resumedEntries,
    });
  } catch (error) {
    replaceHistoryEntries({
      historyStore: args.historyStore,
      historyKey: args.historyKey,
      entries: originalEntries,
    });
    throw error;
  }
}

function commitTaskResumeError(args: {
  historyStore: Pick<WsTaskResumeHandlerDeps["history"]["historyStore"], "clear" | "add">;
  historyKey: string;
  previousEntries: readonly HistoryEntry[];
  message: string;
}): void {
  const originalEntries = cloneHistoryEntries(args.previousEntries);
  const nextEntries = [
    ...cloneHistoryEntries(args.previousEntries),
    {
      role: "status",
      text: args.message,
      ts: Date.now(),
      kind: "error",
    },
  ];

  try {
    replaceHistoryEntries({
      historyStore: args.historyStore,
      historyKey: args.historyKey,
      entries: nextEntries,
    });
  } catch (error) {
    replaceHistoryEntries({
      historyStore: args.historyStore,
      historyKey: args.historyKey,
      entries: originalEntries,
    });
    throw error;
  }
}

export async function handleTaskResumeMessage(
  deps: WsTaskResumeHandlerDeps,
): Promise<{ handled: boolean; orchestrator?: ReturnType<SessionManager["getOrCreate"]> }> {
  if (deps.request.parsed.type !== "task_resume") {
    return { handled: false };
  }

  let orchestrator = deps.sessions.orchestrator;
  const resumeWorkspaceRoot = detectWorkspaceFrom(deps.context.currentCwd);
  const lock = deps.sessions.getWorkspaceLock(resumeWorkspaceRoot);
  const isLaneCurrent = (): boolean => (deps.context.isLaneCurrent ? deps.context.isLaneCurrent() : true);

  await lock.runExclusive(async () => {
    if (!isLaneCurrent()) return;
    const originalHistoryEntries = cloneHistoryEntries(
      deps.history.historyStore.get(deps.context.historyKey),
    );

    const sendPayload = (payload: Record<string, unknown>) => {
      if (!isLaneCurrent()) return;
      if (deps.transport.broadcastJson) {
        deps.transport.broadcastJson(payload);
        return;
      }
      deps.transport.safeJsonSend(deps.transport.ws, payload);
    };
    const sendError = (message: string) => {
      sendPayload({ type: "error", message });
    };

    const sendHistorySnapshot = (metadata?: {
      threadId?: string | null;
      contextMode?: "thread_resumed" | "history_injection";
    }) => {
      if (!isLaneCurrent()) return;
      sendTaskResumeHistorySnapshot({
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        send: deps.transport.broadcastJson ?? ((payload) => deps.transport.safeJsonSend(deps.transport.ws, payload)),
        threadId: metadata?.threadId,
        contextMode: metadata?.contextMode,
      });
    };
    const activeAgentId = orchestrator.getActiveAgentId();
    const runtimeBackend = deps.sessions.sessionManager.getRuntimeBackend?.() ?? DEFAULT_AGENT_RUNTIME;
    const canResumeProviderThread = supportsNativeResume(activeAgentId) && runtimeBackend === "codex-app-server";
    const savedState = deps.sessions.sessionManager.getSavedState?.(deps.context.userId);
    if (savedState?.runtimeBackend && savedState.runtimeBackend !== runtimeBackend) {
      const message =
        `Persisted session runtime backend "${savedState.runtimeBackend}" does not match the active runtime backend "${runtimeBackend}". ` +
        "Cross-runtime resume is not supported.";
      deps.observability.logger.warn(
        `[Web][task_resume] runtime backend mismatch user=${deps.context.userId} history=${deps.context.historyKey} saved=${savedState.runtimeBackend} current=${runtimeBackend}`,
      );
      sendPayload({
        type: "error",
        code: "runtime_backend_mismatch",
        message,
        savedBackend: savedState.runtimeBackend,
        currentBackend: runtimeBackend,
      });
      return;
    }
    const request = parseTaskResumeRequest(deps.request.parsed.payload);
    if (isNativeExecutionId(request.threadId)) {
      const message = "Native execution IDs cannot be resumed as provider threads";
      deps.observability.logger.warn(
        `[Web][task_resume] rejected Native execution alias user=${deps.context.userId} history=${deps.context.historyKey} runtime=${runtimeBackend}`,
      );
      sendError(message);
      return;
    }
    let selectedHistoryEntries: HistoryEntry[] | undefined;
    if (request.threadId && runtimeBackend === "native") {
      const historyOwnerId = resolveHistoryOwnerId(deps.context.authUserId, deps.context.historyKey);
      if (!historyOwnerId) {
        const message = "Session owner is unknown; refusing to restore a conversation";
        deps.observability.logger.warn(
          `[Web][task_resume] rejected restore without session owner user=${deps.context.userId}`,
        );
        sendError(message);
        return;
      }
      const linkedSession = deps.history.historyStore
        .listAgentSessionLinks({ agentId: activeAgentId, limit: 500 })
        .find((link) =>
          link.providerSessionId === request.threadId &&
          link.agentId === activeAgentId &&
          link.historyKey.startsWith(`${historyOwnerId}::`),
        );
      if (!linkedSession) {
        const message = "Selected session has no ADS history to restore";
        deps.observability.logger.warn(
          `[Web][task_resume] rejected unlinked history session user=${deps.context.userId} history=${deps.context.historyKey} agent=${activeAgentId}`,
        );
        sendError(message);
        return;
      }
      if (!areSessionCwdsCompatible(linkedSession.cwd, deps.context.currentCwd)) {
        const message =
          `Selected session belongs to another workspace (${linkedSession.cwd ?? "unknown"}). ` +
          "Switch to that workspace before restoring it.";
        deps.observability.logger.warn(
          `[Web][task_resume] rejected cross-workspace history session user=${deps.context.userId} history=${deps.context.historyKey} sourceCwd=${linkedSession.cwd ?? "none"} currentCwd=${deps.context.currentCwd}`,
        );
        sendError(message);
        return;
      }
      if (linkedSession.historyKey === deps.context.historyKey) {
        // Choosing the conversation this lane already owns must not reset its
        // durable transcript; the Native reattach path below keeps it intact.
        deps.observability.logger.info(
          `[Web][task_resume] restore=native_reattach user=${deps.context.userId} history=${deps.context.historyKey} source=self`,
        );
      } else {
        selectedHistoryEntries = deps.history.historyStore.get(linkedSession.historyKey);
        if (selectedHistoryEntries.length === 0) {
          const message = "Selected session history is empty or no longer available";
          sendError(message);
          return;
        }
        deps.observability.logger.info(
          `[Web][task_resume] selected history session user=${deps.context.userId} history=${deps.context.historyKey} source=${linkedSession.historyKey} agent=${activeAgentId}`,
        );
      }
    }
    const selection = selectTaskResumeThread({
      request: runtimeBackend === "native" ? { ...request, threadId: undefined } : request,
      currentThreadId: runtimeBackend === "codex-app-server" ? orchestrator.getThreadId() : null,
      savedThreadId: deps.sessions.sessionManager.getSavedThreadId(deps.context.userId, activeAgentId),
      savedResumeThreadId: deps.sessions.sessionManager.getSavedResumeThreadId(deps.context.userId),
      savedResumeCwd: savedState?.cwd,
      currentCwd: deps.context.currentCwd,
      canResumeThread: canResumeProviderThread,
    });
    const threadIdToResume = selection.threadId;
    let clearSavedResumeThreadAfterFallback = false;
    let nativeResumeFailure: string | undefined;
    if (isNativeExecutionId(threadIdToResume)) {
      const message = "Native execution IDs cannot be resumed as provider threads";
      deps.observability.logger.warn(
        `[Web][task_resume] rejected Native execution alias user=${deps.context.userId} history=${deps.context.historyKey} runtime=${runtimeBackend} source=${selection.source}`,
      );
      sendError(message);
      return;
    }
    deps.observability.logger.info(
      `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} agent=${activeAgentId} selectedThread=${threadIdToResume ?? "none"} selectionSource=${selection.source ?? "none"}`,
    );

    if (threadIdToResume) {
      try {
        if (!canResumeProviderThread) {
          throw new Error(`provider session resume is not supported for agent=${activeAgentId}`);
        }

        await assertSessionResumable({
          agentId: activeAgentId,
          sessionId: threadIdToResume,
          cwd: deps.context.currentCwd,
        });
        if (!isLaneCurrent()) return;

        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadIdToResume, activeAgentId);
        if (selection.source === "saved") {
          deps.sessions.sessionManager.clearSavedResumeThreadId(deps.context.userId);
        }
        deps.sessions.sessionManager.dropSession(deps.context.userId);

        orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, true, {
          authUserId: deps.context.authUserId,
        });
        orchestrator.setWorkingDirectory(deps.context.currentCwd);

        const status = orchestrator.status();
        if (!status.ready) {
          if (!isLaneCurrent()) return;
          const message = status.error ?? "代理未启用";
          commitTaskResumeError({
            historyStore: deps.history.historyStore,
            historyKey: deps.context.historyKey,
            previousEntries: originalHistoryEntries,
            message,
          });
          sendError(message);
          return;
        }

        if (!isLaneCurrent()) return;
        commitTaskResumeHistory({
          historyStore: deps.history.historyStore,
          historyKey: deps.context.historyKey,
          previousEntries: originalHistoryEntries,
          statusText: "已通过 thread ID 恢复上下文",
        });
        deps.observability.logger.info(
          `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=thread_resumed source=${selection.source ?? "unknown"} thread=${threadIdToResume}`,
        );
        sendHistorySnapshot({
          threadId: runtimeBackend === "codex-app-server"
            ? orchestrator.getThreadId() ?? threadIdToResume
            : null,
          contextMode: "thread_resumed",
        });
        return;
      } catch (error) {
        if (!isLaneCurrent()) return;
        const message = error instanceof Error ? error.message : String(error);
        nativeResumeFailure = describeNativeResumeFailure(activeAgentId, message);
        deps.observability.logger.warn(
          `[Web][task_resume] resumeThread failed thread=${threadIdToResume} reason=${nativeResumeFailure} err=${truncateForLog(message)}`,
        );
        if (selection.source === "saved" && isPermanentTaskResumeFailure(message)) {
          clearSavedResumeThreadAfterFallback = true;
          deps.observability.logger.info(
            `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} clearingSavedResumeThread=true thread=${threadIdToResume} reason=permanent_resume_failure`,
          );
        }
      }
    }

    if (clearSavedResumeThreadAfterFallback) {
      if (!isLaneCurrent()) return;
      deps.sessions.sessionManager.clearSavedResumeThreadId(deps.context.userId);
      clearSavedResumeThreadAfterFallback = false;
    }

    if (runtimeBackend === "native" && !selectedHistoryEntries) {
      // Native has no provider thread to resume: the durable transcript is the
      // session. Reattaching keeps tool evidence and earlier turns that a
      // reset-plus-recap would drop, and a lane that really has no transcript
      // still gets its history injected on the next prompt.
      orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, true, {
        authUserId: deps.context.authUserId,
      });
      orchestrator.setWorkingDirectory(deps.context.currentCwd);
      const status = orchestrator.status();
      if (!isLaneCurrent()) return;
      if (!status.ready) {
        const message = status.error ?? "代理未启用";
        commitTaskResumeError({
          historyStore: deps.history.historyStore,
          historyKey: deps.context.historyKey,
          previousEntries: originalHistoryEntries,
          message,
        });
        sendError(message);
        return;
      }
      const restoreMode = deps.sessions.sessionManager.getContextRestoreMode(deps.context.userId);
      if (restoreMode === "thread_resumed") {
        commitTaskResumeHistory({
          historyStore: deps.history.historyStore,
          historyKey: deps.context.historyKey,
          previousEntries: originalHistoryEntries,
          statusText: "已恢复会话记录",
        });
      }
      deps.observability.logger.info(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=native_reattached mode=${restoreMode}`,
      );
      sendHistorySnapshot({
        threadId: null,
        contextMode: restoreMode === "thread_resumed" ? "thread_resumed" : undefined,
      });
      return;
    }

    const resumeEntries = selectedHistoryEntries ?? originalHistoryEntries;
    const laneHistoryTranscript = buildHistoryStoreResumeTranscript(resumeEntries);
    if (!isLaneCurrent()) return;
    // Only set when a native resume was actually attempted, so the untried case
    // keeps its original wording.
    const degradePrefix = nativeResumeFailure ? `未能原生恢复（${nativeResumeFailure}），` : "";
    const restoreTarget = selectedHistoryEntries ? "所选会话" : "当前对话";
    const resumeContext = laneHistoryTranscript
      ? {
          transcript: laneHistoryTranscript,
          statusText: `${degradePrefix}已从${restoreTarget}恢复上下文`,
        }
      : null;

    if (!resumeContext) {
      deps.observability.logger.warn(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=unavailable reason=${nativeResumeFailure ? "native_resume_failed" : "no_resume_context"}`,
      );
      const message = nativeResumeFailure
        ? `未能原生恢复（${nativeResumeFailure}），且未找到可用于恢复的任务历史`
        : "未找到可用于恢复的任务历史";
      commitTaskResumeError({
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        previousEntries: originalHistoryEntries,
        message,
      });
      sendError(message);
      return;
    }
    const { transcript, statusText } = resumeContext;
    const transcriptSource = selectedHistoryEntries
      ? "selected_history"
      : laneHistoryTranscript
        ? "lane_history"
        : "recent_task";

    if (!isLaneCurrent()) return;
    deps.sessions.sessionManager.dropSession(deps.context.userId);
    orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, false, {
      authUserId: deps.context.authUserId,
    });
    orchestrator.setWorkingDirectory(deps.context.currentCwd);

    const status = orchestrator.status();
    if (!status.ready) {
      if (!isLaneCurrent()) return;
      const message = status.error ?? "代理未启用";
      commitTaskResumeError({
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        previousEntries: originalHistoryEntries,
        message,
      });
      sendError(message);
      return;
    }
    try {
      if (!isLaneCurrent()) return;
      const prompt = [
        "你正在帮助我恢复对话上下文。以下是最近保留的对话片段（仅用于恢复上下文，不要逐条复述）：",
        transcript,
        "",
        "请回复：OK",
      ]
        .filter(Boolean)
        .join("\n");
      await orchestrator.send(prompt, { streaming: false });
      if (!isLaneCurrent()) return;
      const threadId = runtimeBackend === "codex-app-server" ? orchestrator.getThreadId() : null;
      if (threadId) {
        const activeAgentId = orchestrator.getActiveAgentId();
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, activeAgentId);
        if (
          canResumeProviderThread &&
          typeof deps.history.historyStore.linkAgentSession === "function"
        ) {
          deps.history.historyStore.linkAgentSession(deps.context.historyKey, {
            agentId: activeAgentId,
            providerSessionId: threadId,
            cwd: deps.context.currentCwd,
          });
        }
      }
      deps.observability.logger.info(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=history_injection source=${transcriptSource} degradedFrom=${nativeResumeFailure ? "native_resume" : "none"} savedThread=${threadId ?? "none"}`,
      );
    } catch (error) {
      if (!isLaneCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      deps.observability.logger.warn(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=history_injection source=${transcriptSource} failed err=${truncateForLog(message)}`,
      );
      const errorMessage = `恢复失败: ${message}`;
      commitTaskResumeError({
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        previousEntries: originalHistoryEntries,
        message: errorMessage,
      });
      sendError(errorMessage);
      return;
    }

    if (!isLaneCurrent()) return;
    if (selectedHistoryEntries) {
      const restoredEntries = buildRestoredHistory({
        previousEntries: originalHistoryEntries,
        selectedEntries: selectedHistoryEntries,
        statusText,
      });
      if (!deps.history.historyStore.replaceEntries(deps.context.historyKey, restoredEntries)) {
        const errorMessage = "Failed to persist the selected conversation history";
        sendError(errorMessage);
        return;
      }
    } else {
      commitTaskResumeHistory({
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        previousEntries: originalHistoryEntries,
        statusText,
      });
    }
    sendHistorySnapshot({
      threadId: runtimeBackend === "codex-app-server" ? orchestrator.getThreadId() : null,
      contextMode: "history_injection",
    });
  });

  return { handled: true, orchestrator };
}

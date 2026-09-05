import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { SessionManager } from "../../../sessions/sessionManager.js";
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
import {
  isPermanentTaskResumeFailure,
  parseTaskResumeRequest,
  selectTaskResumeThread,
} from "./taskResume.js";

function cloneHistoryEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => ({ ...entry }));
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

    const sendError = (message: string) => {
      if (!isLaneCurrent()) return;
      const payload = { type: "error", message };
      if (deps.transport.broadcastJson) {
        deps.transport.broadcastJson(payload);
        return;
      }
      deps.transport.safeJsonSend(deps.transport.ws, payload);
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
    const savedState = deps.sessions.sessionManager.getSavedState?.(deps.context.userId);
    const request = parseTaskResumeRequest(deps.request.parsed.payload);
    const selection = selectTaskResumeThread({
      request,
      currentThreadId: orchestrator.getThreadId(),
      savedThreadId: deps.sessions.sessionManager.getSavedThreadId(deps.context.userId, activeAgentId),
      savedResumeThreadId: deps.sessions.sessionManager.getSavedResumeThreadId(deps.context.userId),
      savedResumeCwd: savedState?.cwd,
      currentCwd: deps.context.currentCwd,
      canResumeThread: supportsNativeResume(activeAgentId),
    });
    const threadIdToResume = selection.threadId;
    let clearSavedResumeThreadAfterFallback = false;
    let nativeResumeFailure: string | undefined;
    deps.observability.logger.info(
      `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} agent=${activeAgentId} selectedThread=${threadIdToResume ?? "none"} selectionSource=${selection.source ?? "none"}`,
    );

    if (threadIdToResume) {
      try {
        if (!supportsNativeResume(activeAgentId)) {
          throw new Error(`native session resume is not supported for agent=${activeAgentId}`);
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

        orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, true);
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
          threadId: orchestrator.getThreadId() ?? threadIdToResume,
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

    const laneHistoryTranscript = buildHistoryStoreResumeTranscript(originalHistoryEntries);
    if (!isLaneCurrent()) return;
    // Only set when a native resume was actually attempted, so the untried case
    // keeps its original wording.
    const degradePrefix = nativeResumeFailure ? `未能原生恢复（${nativeResumeFailure}），` : "";
    const resumeContext = laneHistoryTranscript
      ? {
          transcript: laneHistoryTranscript,
          statusText: `${degradePrefix}已从当前对话恢复上下文`,
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
    const transcriptSource = laneHistoryTranscript ? "lane_history" : "recent_task";

    if (!isLaneCurrent()) return;
    deps.sessions.sessionManager.dropSession(deps.context.userId);
    orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, false);
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
      const threadId = orchestrator.getThreadId();
      if (threadId) {
        const activeAgentId = orchestrator.getActiveAgentId();
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, activeAgentId);
        if (typeof deps.history.historyStore.linkAgentSession === "function") {
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
    commitTaskResumeHistory({
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      previousEntries: originalHistoryEntries,
      statusText,
    });
    sendHistorySnapshot({
      threadId: orchestrator.getThreadId(),
      contextMode: "history_injection",
    });
  });

  return { handled: true, orchestrator };
}

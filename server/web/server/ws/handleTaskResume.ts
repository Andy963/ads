import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";
import { truncateForLog } from "../../utils.js";
import type {
  WsTaskResumeHandlerDeps,
} from "./deps.js";
import {
  buildHistoryStoreResumeTranscript,
  loadTaskResumeConversationContext,
} from "./taskResumeConversation.js";
import { assertCodexThreadResumable } from "./taskResumeCodex.js";
import { sendTaskResumeHistorySnapshot } from "./taskResumeHistory.js";
import {
  isPermanentTaskResumeFailure,
  parseTaskResumeRequest,
  selectTaskResumeThread,
} from "./taskResume.js";

function cloneHistoryEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => ({ ...entry }));
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

export async function handleTaskResumeMessage(
  deps: WsTaskResumeHandlerDeps,
): Promise<{ handled: boolean; orchestrator?: ReturnType<SessionManager["getOrCreate"]> }> {
  if (deps.request.parsed.type !== "task_resume") {
    return { handled: false };
  }

  let orchestrator = deps.sessions.orchestrator;
  const resumeWorkspaceRoot = detectWorkspaceFrom(deps.context.currentCwd);
  const lock = deps.sessions.getWorkspaceLock(resumeWorkspaceRoot);

  await lock.runExclusive(async () => {
    const taskCtx = deps.tasks.ensureTaskContext(resumeWorkspaceRoot);

    if (taskCtx.queueRunning || taskCtx.taskStore.getActiveTaskId()) {
      deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: "任务执行中，无法恢复上下文" });
      return;
    }

    const sendHistorySnapshot = () =>
      sendTaskResumeHistorySnapshot({
        historyStore: deps.history.historyStore,
        historyKey: deps.context.historyKey,
        send: (payload) => deps.transport.safeJsonSend(deps.transport.ws, payload),
      });
    const originalHistoryEntries = cloneHistoryEntries(
      deps.history.historyStore.get(deps.context.historyKey),
    );

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
      canResumeThread: activeAgentId === "codex",
    });
    const threadIdToResume = selection.threadId;
    let clearSavedResumeThreadAfterFallback = false;
    deps.observability.logger.info(
      `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} agent=${activeAgentId} selectedThread=${threadIdToResume ?? "none"} selectionSource=${selection.source ?? "none"}`,
    );

    if (threadIdToResume) {
      try {
        if (activeAgentId !== "codex") {
          throw new Error(`task_resume via thread id is only supported for codex (active=${activeAgentId})`);
        }

        await assertCodexThreadResumable({
          threadId: threadIdToResume,
          cwd: deps.context.currentCwd,
          sandboxMode: deps.sessions.sessionManager.getSandboxMode(),
          env: deps.sessions.sessionManager.getCodexEnv(),
        });

        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadIdToResume, activeAgentId);
        if (selection.source === "saved") {
          deps.sessions.sessionManager.clearSavedResumeThreadId(deps.context.userId);
        }
        deps.sessions.sessionManager.dropSession(deps.context.userId);

        orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, true);
        orchestrator.setWorkingDirectory(deps.context.currentCwd);

        const status = orchestrator.status();
        if (!status.ready) {
          deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: status.error ?? "代理未启用" });
          return;
        }

        commitTaskResumeHistory({
          historyStore: deps.history.historyStore,
          historyKey: deps.context.historyKey,
          previousEntries: originalHistoryEntries,
          statusText: "已通过 thread ID 恢复上下文",
        });
        deps.observability.logger.info(
          `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=thread_resumed source=${selection.source ?? "unknown"} thread=${threadIdToResume}`,
        );
        sendHistorySnapshot();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.observability.logger.warn(
          `[Web][task_resume] resumeThread failed thread=${threadIdToResume} err=${truncateForLog(message)}`,
        );
        if (selection.source === "saved" && isPermanentTaskResumeFailure(message)) {
          clearSavedResumeThreadAfterFallback = true;
          deps.observability.logger.info(
            `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} clearingSavedResumeThread=true thread=${threadIdToResume} reason=permanent_resume_failure`,
          );
        }
      }
    }

    const laneHistoryTranscript = buildHistoryStoreResumeTranscript(originalHistoryEntries);
    const resumeContext = laneHistoryTranscript
      ? {
          transcript: laneHistoryTranscript,
          statusText: "已从当前对话恢复上下文",
        }
      : (() => {
          const taskResumeContext = loadTaskResumeConversationContext(taskCtx.taskStore);
          if (!taskResumeContext) {
            return null;
          }
          return {
            transcript: taskResumeContext.transcript,
            statusText: `已从最近任务恢复上下文：${String(taskResumeContext.task.title ?? taskResumeContext.task.id ?? "").trim()}`,
          };
        })();

    if (!resumeContext) {
      deps.observability.logger.warn(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=unavailable reason=no_resume_context`,
      );
      deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: "未找到可用于恢复的任务历史" });
      return;
    }
    const { transcript, statusText } = resumeContext;
    const transcriptSource = laneHistoryTranscript ? "lane_history" : "recent_task";

    if (clearSavedResumeThreadAfterFallback) {
      deps.sessions.sessionManager.clearSavedResumeThreadId(deps.context.userId);
    }
    deps.sessions.sessionManager.dropSession(deps.context.userId);
    orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, deps.context.currentCwd, false);
    orchestrator.setWorkingDirectory(deps.context.currentCwd);

    const status = orchestrator.status();
    if (!status.ready) {
      deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: status.error ?? "代理未启用" });
      return;
    }
    try {
      const prompt = [
        "你正在帮助我恢复对话上下文。以下是最近保留的对话片段（仅用于恢复上下文，不要逐条复述）：",
        transcript,
        "",
        "请回复：OK",
      ]
        .filter(Boolean)
        .join("\n");
      await orchestrator.send(prompt, { streaming: false });
      const threadId = orchestrator.getThreadId();
      if (threadId) {
        deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, orchestrator.getActiveAgentId());
      }
      deps.observability.logger.info(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=history_injection source=${transcriptSource} savedThread=${threadId ?? "none"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.observability.logger.warn(
        `[Web][task_resume] user=${deps.context.userId} history=${deps.context.historyKey} restore=history_injection source=${transcriptSource} failed err=${truncateForLog(message)}`,
      );
      deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: `恢复失败: ${message}` });
      return;
    }

    commitTaskResumeHistory({
      historyStore: deps.history.historyStore,
      historyKey: deps.context.historyKey,
      previousEntries: originalHistoryEntries,
      statusText,
    });
    sendHistorySnapshot();
  });

  return { handled: true, orchestrator };
}

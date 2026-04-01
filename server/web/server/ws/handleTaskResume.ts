import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { truncateForLog } from "../../utils.js";
import type {
  WsTaskResumeHandlerDeps,
} from "./deps.js";
import { loadTaskResumeConversationContext } from "./taskResumeConversation.js";
import { assertCodexThreadResumable } from "./taskResumeCodex.js";
import { sendTaskResumeHistorySnapshot } from "./taskResumeHistory.js";
import {
  isPermanentTaskResumeFailure,
  parseTaskResumeRequest,
  selectTaskResumeThread,
} from "./taskResume.js";

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

    const activeAgentId = orchestrator.getActiveAgentId();
    const request = parseTaskResumeRequest(deps.request.parsed.payload);
    const selection = selectTaskResumeThread({
      request,
      currentThreadId: orchestrator.getThreadId(),
      savedThreadId: deps.sessions.sessionManager.getSavedThreadId(deps.context.userId, activeAgentId),
      savedResumeThreadId: deps.sessions.sessionManager.getSavedResumeThreadId(deps.context.userId),
    });
    const threadIdToResume = selection.threadId;
    let clearSavedResumeThreadAfterFallback = false;

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

        deps.history.historyStore.clear(deps.context.historyKey);
        deps.history.historyStore.add(deps.context.historyKey, {
          role: "status",
          text: "已通过 thread ID 恢复上下文",
          ts: Date.now(),
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

        sendHistorySnapshot();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.observability.logger.warn(
          `[Web][task_resume] resumeThread failed thread=${threadIdToResume} err=${truncateForLog(message)}`,
        );
        if (selection.source === "saved" && isPermanentTaskResumeFailure(message)) {
          clearSavedResumeThreadAfterFallback = true;
        }
      }
    }

    const resumeContext = loadTaskResumeConversationContext(taskCtx.taskStore);

    if (!resumeContext) {
      deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: "未找到可用于恢复的任务历史" });
      return;
    }
    const { task: mostRecentTask, transcript } = resumeContext;

    deps.history.historyStore.clear(deps.context.historyKey);
    deps.history.historyStore.add(deps.context.historyKey, {
      role: "status",
      text: `已从最近任务恢复上下文：${String(mostRecentTask.title ?? mostRecentTask.id ?? "").trim()}`,
      ts: Date.now(),
    });

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
        "你正在帮助我恢复对话上下文。以下是最近一次任务执行的对话片段（仅用于恢复上下文，不要逐条复述）：",
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.transport.safeJsonSend(deps.transport.ws, { type: "error", message: `恢复失败: ${message}` });
      return;
    }

    sendHistorySnapshot();
  });

  return { handled: true, orchestrator };
}

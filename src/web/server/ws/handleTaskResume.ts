import { runCli } from "../../../agents/cli/cliRunner.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { truncateForLog } from "../../utils.js";
import type { WsMessage } from "./schema.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import { parseTaskResumeRequest, selectTaskResumeThread } from "./taskResume.js";

function normalizeSpawnEnv(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

type ThreadEventLike = { type: string; error?: { message?: string }; message?: string };

function isThreadEventLike(payload: unknown): payload is ThreadEventLike {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const typeValue = (payload as { type?: unknown }).type;
  return typeof typeValue === "string" && typeValue.length > 0;
}

async function assertCodexThreadResumable(args: {
  threadId: string;
  cwd: string;
  sandboxMode: ReturnType<SessionManager["getSandboxMode"]>;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<void> {
  const threadId = args.threadId.trim();
  if (!threadId) {
    throw new Error("empty thread id");
  }

  const binary = process.env.ADS_CODEX_BIN ?? "codex";
  const cliArgs: string[] = ["exec"];

  if (args.sandboxMode === "read-only") {
    cliArgs.push("--sandbox", "read-only");
  }

  cliArgs.push("resume");

  if (args.sandboxMode === "danger-full-access") {
    cliArgs.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (args.sandboxMode !== "read-only") {
    cliArgs.push("--full-auto");
  }

  cliArgs.push("--json", "--skip-git-repo-check", threadId, "-");

  let sawTurnFailed = false;
  let lastError: string | null = null;

  const result = await runCli(
    {
      binary,
      args: cliArgs,
      cwd: args.cwd,
      env: normalizeSpawnEnv(args.env),
      stdinData: "Reply with exactly OK. Do not run any tools.\n",
    },
    (parsed) => {
      if (!isThreadEventLike(parsed)) {
        return;
      }
      if (parsed.type === "turn.failed") {
        sawTurnFailed = true;
        const message = parsed.error?.message;
        if (typeof message === "string" && message.trim()) {
          lastError = message.trim();
        }
      }
      if (parsed.type === "error") {
        const message = parsed.message;
        if (typeof message === "string" && message.trim()) {
          lastError = message.trim();
        }
      }
    },
  );

  if (result.exitCode !== 0 || sawTurnFailed) {
    const stderr = result.stderr.trim();
    const message = lastError ?? (stderr || `codex exited with code ${result.exitCode}`);
    throw new Error(message);
  }
}

export async function handleTaskResumeMessage(deps: {
  parsed: WsMessage;
  ws: import("ws").WebSocket;
  userId: number;
  historyKey: string;
  currentCwd: string;
  ensureTaskContext: (workspaceRoot: string) => TaskQueueContext;
  historyStore: HistoryStore;
  sessionManager: SessionManager;
  safeJsonSend: (ws: import("ws").WebSocket, payload: unknown) => void;
  logger: { warn: (msg: string) => void };
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}): Promise<{ handled: boolean; orchestrator?: ReturnType<SessionManager["getOrCreate"]> }> {
  if (deps.parsed.type !== "task_resume") {
    return { handled: false };
  }

  let orchestrator = deps.orchestrator;
  const resumeWorkspaceRoot = detectWorkspaceFrom(deps.currentCwd);
  const lock = deps.getWorkspaceLock(resumeWorkspaceRoot);

  await lock.runExclusive(async () => {
    const taskCtx = deps.ensureTaskContext(resumeWorkspaceRoot);

    if (taskCtx.queueRunning || taskCtx.taskStore.getActiveTaskId()) {
      deps.safeJsonSend(deps.ws, { type: "error", message: "任务执行中，无法恢复上下文" });
      return;
    }

    const sendHistorySnapshot = () => {
      const cachedHistory = deps.historyStore.get(deps.historyKey);
      if (cachedHistory.length === 0) {
        deps.safeJsonSend(deps.ws, { type: "history", items: [] });
        return;
      }
      const sanitizedHistory = cachedHistory.map((entry) => {
        if (entry.role !== "ai") {
          return entry;
        }
        const cleanedText = stripLeadingTranslation(entry.text);
        if (cleanedText === entry.text) {
          return entry;
        }
        return { ...entry, text: cleanedText };
      });
      const cdPattern = /^\/cd\b/i;
      const isCdCommand = (entry: { role: string; text: string }) =>
        entry.role === "user" && cdPattern.test(String(entry.text ?? "").trim());
      let lastCdIndex = -1;
      for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
        if (isCdCommand(sanitizedHistory[i])) {
          lastCdIndex = i;
          break;
        }
      }
      const filteredHistory =
        lastCdIndex >= 0
          ? sanitizedHistory.filter((entry, idx) => !isCdCommand(entry) || idx === lastCdIndex)
          : sanitizedHistory;
      deps.safeJsonSend(deps.ws, { type: "history", items: filteredHistory });
    };

    const activeAgentId = orchestrator.getActiveAgentId();
    const request = parseTaskResumeRequest(deps.parsed.payload);
    const selection = selectTaskResumeThread({
      request,
      currentThreadId: orchestrator.getThreadId(),
      savedThreadId: deps.sessionManager.getSavedThreadId(deps.userId, activeAgentId),
      savedResumeThreadId: deps.sessionManager.getSavedResumeThreadId(deps.userId),
    });
    const threadIdToResume = selection.threadId;

    if (threadIdToResume) {
      try {
        if (activeAgentId !== "codex") {
          throw new Error(`task_resume via thread id is only supported for codex (active=${activeAgentId})`);
        }

        await assertCodexThreadResumable({
          threadId: threadIdToResume,
          cwd: deps.currentCwd,
          sandboxMode: deps.sessionManager.getSandboxMode(),
          env: deps.sessionManager.getCodexEnv(),
        });

        deps.historyStore.clear(deps.historyKey);
        deps.historyStore.add(deps.historyKey, {
          role: "status",
          text: "已通过 thread ID 恢复上下文",
          ts: Date.now(),
        });

        deps.sessionManager.saveThreadId(deps.userId, threadIdToResume, activeAgentId);
        if (selection.source === "saved") {
          deps.sessionManager.clearSavedResumeThreadId(deps.userId);
        }
        deps.sessionManager.dropSession(deps.userId);

        orchestrator = deps.sessionManager.getOrCreate(deps.userId, deps.currentCwd, true);
        orchestrator.setWorkingDirectory(deps.currentCwd);

        const status = orchestrator.status();
        if (!status.ready) {
          deps.safeJsonSend(deps.ws, { type: "error", message: status.error ?? "代理未启用" });
          return;
        }

        sendHistorySnapshot();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(
          `[Web][task_resume] resumeThread failed thread=${threadIdToResume} err=${truncateForLog(message)}`,
        );
      }
    }

    const candidates = [
      ...taskCtx.taskStore.listTasks({ status: "completed", limit: 50 }),
      ...taskCtx.taskStore.listTasks({ status: "failed", limit: 50 }),
      ...taskCtx.taskStore.listTasks({ status: "cancelled", limit: 50 }),
    ];
    const mostRecentTask =
      candidates
        .slice()
        .sort((a, b) => {
          const at = (a.completedAt ?? a.startedAt ?? a.createdAt) ?? 0;
          const bt = (b.completedAt ?? b.startedAt ?? b.createdAt) ?? 0;
          return bt - at;
        })[0] ?? null;

    if (!mostRecentTask) {
      deps.safeJsonSend(deps.ws, { type: "error", message: "未找到可用于恢复的任务历史" });
      return;
    }

    const conversationId =
      String(mostRecentTask.threadId ?? "").trim() || `conv-${String(mostRecentTask.id ?? "").trim()}`;
    const conversationMessages = taskCtx.taskStore
      .getConversationMessages(conversationId, { limit: 24 })
      .filter((m) => m.role === "user" || m.role === "assistant");

    const rawTranscript = conversationMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content ?? "").trim()}`)
      .filter(Boolean)
      .join("\n");
    const maxChars = 10_000;
    const transcript = rawTranscript.length <= maxChars ? rawTranscript : rawTranscript.slice(rawTranscript.length - maxChars);

    deps.historyStore.clear(deps.historyKey);
    deps.historyStore.add(deps.historyKey, {
      role: "status",
      text: `已从最近任务恢复上下文：${String(mostRecentTask.title ?? mostRecentTask.id ?? "").trim()}`,
      ts: Date.now(),
    });

    deps.sessionManager.dropSession(deps.userId, { clearSavedThread: true });
    orchestrator = deps.sessionManager.getOrCreate(deps.userId, deps.currentCwd, false);
    orchestrator.setWorkingDirectory(deps.currentCwd);

    const status = orchestrator.status();
    if (!status.ready) {
      deps.safeJsonSend(deps.ws, { type: "error", message: status.error ?? "代理未启用" });
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
        deps.sessionManager.saveThreadId(deps.userId, threadId, orchestrator.getActiveAgentId());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.safeJsonSend(deps.ws, { type: "error", message: `恢复失败: ${message}` });
      return;
    }

    sendHistorySnapshot();
  });

  return { handled: true, orchestrator };
}

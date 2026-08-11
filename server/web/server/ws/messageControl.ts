import type { WebSocket } from "ws";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsLogger, WsPromptSessionLogger, WsTaskResumeHandlerDeps } from "./deps.js";
import { invalidateWsPromptRun } from "./promptLifecycle.js";
import { handleSessionListMessage } from "./handleSessionList.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import type { WsMessage } from "./schema.js";

type ClearHistoryScope = "lane" | "shared";

function resolveClearHistoryScope(payload: unknown): ClearHistoryScope {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "lane";
  }
  const scope = String((payload as Record<string, unknown>).scope ?? "").trim().toLowerCase();
  return scope === "shared" || scope === "project" ? "shared" : "lane";
}

export function ensureWsSessionLogger(args: {
  sessionManager: SessionManager;
  userId: number;
  warn: WsLogger["warn"];
}): WsPromptSessionLogger | null {
  try {
    return (args.sessionManager.ensureLogger(args.userId) ?? null) as WsPromptSessionLogger | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.warn(`[WebSocket] Failed to initialize session logger: ${message}`);
    return null;
  }
}

export async function handleWsControlMessage(args: {
  parsed: WsMessage;
  chatSessionId: string;
  userId: number;
  historyKey: string;
  currentCwd: string;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: WsTaskResumeHandlerDeps["sessions"]["getWorkspaceLock"];
  historyStore: WsTaskResumeHandlerDeps["history"]["historyStore"];
  interruptControllers?: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  ensureTaskContext: WsTaskResumeHandlerDeps["tasks"]["ensureTaskContext"];
  sendJson: (payload: unknown) => void;
  broadcastJson?: (payload: unknown) => void;
  broadcastSessionReset?: (payload: unknown) => void;
  resetSharedSessionState?: (options: {
    sourceChatSessionId: string;
  }) => void;
  logger: Pick<WsLogger, "info" | "warn">;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (args.parsed.type === "clear_history") {
    const scope = resolveClearHistoryScope(args.parsed.payload);
    if (args.interruptControllers) {
      invalidateWsPromptRun({
        historyKey: args.historyKey,
        interruptControllers: args.interruptControllers,
        promptRunEpochs: args.promptRunEpochs,
      });
    }
    args.logger.info(
      `[Web][continuity] reset source=clear_history scope=${scope} user=${args.userId} history=${args.historyKey}`,
    );
    if (scope === "shared" && args.resetSharedSessionState) {
      args.resetSharedSessionState({ sourceChatSessionId: args.chatSessionId });
    } else {
      args.historyStore.clear(args.historyKey);
      args.sessionManager.reset(args.userId);
    }
    args.broadcastSessionReset?.({
      type: "session_reset",
      source: "clear_history",
      sourceChatSessionId: args.chatSessionId,
      scope,
    });
    args.sendJson({ type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
    return { handled: true, orchestrator: args.orchestrator };
  }

  if (args.parsed.type === "task_resume") {
    const resume = await handleTaskResumeMessage({
      request: { parsed: args.parsed },
      transport: {
        ws: {} as WebSocket,
        safeJsonSend: (_ws, payload) => args.sendJson(payload),
        broadcastJson: args.broadcastJson,
      },
      observability: {
        logger: {
          warn: args.logger.warn,
          info: args.logger.info,
          debug: () => {},
        },
      },
      context: {
        userId: args.userId,
        historyKey: args.historyKey,
        currentCwd: args.currentCwd,
      },
      sessions: {
        sessionManager: args.sessionManager,
        orchestrator: args.orchestrator,
        getWorkspaceLock: args.getWorkspaceLock,
      },
      history: {
        historyStore: args.historyStore,
      },
      tasks: {
        ensureTaskContext: args.ensureTaskContext,
      },
    });
    return { handled: true, orchestrator: resume.orchestrator ?? args.orchestrator };
  }

  if (args.parsed.type === "session_list") {
    await handleSessionListMessage({
      payload: args.parsed.payload,
      historyStore: args.historyStore as unknown as HistoryStore,
      currentCwd: args.currentCwd,
      activeAgentId: args.orchestrator.getActiveAgentId(),
      currentSessionId: args.orchestrator.getThreadId(),
      sendJson: args.sendJson,
      logger: args.logger,
    });
    return { handled: true, orchestrator: args.orchestrator };
  }

  return { handled: false, orchestrator: args.orchestrator };
}

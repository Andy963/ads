import type { WebSocket } from "ws";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { WsLogger, WsPromptSessionLogger, WsTaskResumeHandlerDeps } from "./deps.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import type { WsMessage } from "./schema.js";

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
  isReviewerChat: boolean;
  userId: number;
  historyKey: string;
  currentCwd: string;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: WsTaskResumeHandlerDeps["sessions"]["getWorkspaceLock"];
  historyStore: WsTaskResumeHandlerDeps["history"]["historyStore"];
  reviewerSnapshotBindings: Map<string, string>;
  ensureTaskContext: WsTaskResumeHandlerDeps["tasks"]["ensureTaskContext"];
  sendJson: (payload: unknown) => void;
  logger: Pick<WsLogger, "warn">;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (args.parsed.type === "clear_history") {
    args.historyStore.clear(args.historyKey);
    args.sessionManager.reset(args.userId);
    if (args.isReviewerChat) {
      args.reviewerSnapshotBindings.delete(args.historyKey);
    }
    args.sendJson({ type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
    return { handled: true, orchestrator: args.orchestrator };
  }

  if (args.parsed.type === "task_resume") {
    if (args.isReviewerChat) {
      args.sendJson({ type: "error", message: "Reviewer lane does not support resuming threads." });
      return { handled: true, orchestrator: args.orchestrator };
    }
    const resume = await handleTaskResumeMessage({
      request: { parsed: args.parsed },
      transport: {
        ws: {} as WebSocket,
        safeJsonSend: (_ws, payload) => args.sendJson(payload),
      },
      observability: {
        logger: {
          warn: args.logger.warn,
          info: () => {},
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

  if (args.isReviewerChat && (args.parsed.type === "command" || args.parsed.type === "set_agent")) {
    args.sendJson({ type: "error", message: "Reviewer lane is read-only and does not accept commands." });
    return { handled: true, orchestrator: args.orchestrator };
  }

  return { handled: false, orchestrator: args.orchestrator };
}

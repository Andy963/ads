import type { WebSocket } from "ws";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { handleCommandMessage } from "./handleCommand.js";
import type {
  WsCommandHandlerDeps,
  WsCommandRuntimeDeps,
  WsHistoryRuntimeDeps,
  WsLogger,
  WsRequestDeps,
  WsSchedulerDeps,
  WsSessionRuntimeDeps,
  WsTaskResumeHandlerDeps,
  WsTaskRuntimeDeps,
} from "./deps.js";
import { handlePromptMessage } from "./handlePrompt.js";
import { ensureWsSessionLogger, handleWsControlMessage } from "./messageControl.js";
import type { WsMessage } from "./schema.js";

export type IncomingWsMessage = {
  parsed: WsMessage;
  requestId: string;
  clientMessageId: string | null;
  receivedAt: number;
};

export async function dispatchWsMessage(args: {
  msg: IncomingWsMessage;
  ws: WebSocket;
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  userId: number;
  historyKey: string;
  currentCwd: string;
  cacheKey: string;
  isReviewerChat: boolean;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: WsSessionRuntimeDeps["getWorkspaceLock"];
  interruptControllers: Map<string, AbortController>;
  historyStore: WsHistoryRuntimeDeps["historyStore"];
  tasks: WsTaskRuntimeDeps;
  scheduler: WsSchedulerDeps;
  commands: WsCommandRuntimeDeps;
  agents: WsCommandHandlerDeps["agents"];
  state: Omit<WsCommandHandlerDeps["state"], "cacheKey">;
  reviewerSnapshotBindings: Map<string, string>;
  registerSessionCacheBinding: () => void;
  broadcastJson: (payload: unknown) => void;
  safeJsonSend: (ws: WebSocket, payload: unknown) => void;
  sendWorkspaceState: (ws: WebSocket, workspaceRoot: string) => void;
  traceWsDuplication: boolean;
  logger: WsLogger;
  updateWorkspaceRootMeta: (cwd: string) => void;
}): Promise<{
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  currentCwd: string;
}> {
  const orchestrator = args.orchestrator;
  let currentCwd = args.currentCwd;

  try {
    args.registerSessionCacheBinding();
    const parsed = args.msg.parsed;
    const requestId = args.msg.requestId;
    const clientMessageId = args.msg.clientMessageId;

    const sessionLogger = ensureWsSessionLogger({
      sessionManager: args.sessionManager,
      userId: args.userId,
      warn: args.logger.warn,
    });

    const control = await handleWsControlMessage({
      parsed,
      isReviewerChat: args.isReviewerChat,
      userId: args.userId,
      historyKey: args.historyKey,
      currentCwd,
      sessionManager: args.sessionManager,
      orchestrator,
      getWorkspaceLock: args.getWorkspaceLock,
      historyStore: args.historyStore,
      reviewerSnapshotBindings: args.reviewerSnapshotBindings,
      ensureTaskContext: args.tasks.ensureTaskContext as WsTaskResumeHandlerDeps["tasks"]["ensureTaskContext"],
      sendJson: (payload) => args.safeJsonSend(args.ws, payload),
      logger: args.logger,
    });
    if (control.handled) {
      return { orchestrator: control.orchestrator, currentCwd };
    }

    const promptResult = await handlePromptMessage({
      request: {
        parsed,
        requestId,
        clientMessageId,
        receivedAt: args.msg.receivedAt,
      } satisfies WsRequestDeps,
      transport: {
        ws: args.ws,
        safeJsonSend: args.safeJsonSend,
        broadcastJson: args.broadcastJson,
        sendWorkspaceState: args.sendWorkspaceState,
      },
      observability: {
        logger: args.logger,
        sessionLogger,
        traceWsDuplication: args.traceWsDuplication,
      },
      context: {
        authUserId: args.authUserId,
        sessionId: args.sessionId,
        chatSessionId: args.chatSessionId,
        userId: args.userId,
        historyKey: args.historyKey,
        currentCwd,
      },
      sessions: {
        sessionManager: args.sessionManager,
        orchestrator,
        getWorkspaceLock: args.getWorkspaceLock,
        interruptControllers: args.interruptControllers,
      },
      history: {
        historyStore: args.historyStore,
      },
      tasks: args.tasks,
      scheduler: args.scheduler,
      reviewerSnapshotBindings: args.reviewerSnapshotBindings,
    });
    if (promptResult.handled) {
      return { orchestrator: promptResult.orchestrator, currentCwd };
    }

    const commandResult = await handleCommandMessage({
      request: {
        parsed,
        clientMessageId,
      },
      transport: {
        ws: args.ws,
        safeJsonSend: args.safeJsonSend,
        broadcastJson: args.broadcastJson,
        sendWorkspaceState: args.sendWorkspaceState,
      },
      observability: {
        logger: args.logger,
        sessionLogger,
        traceWsDuplication: args.traceWsDuplication,
      },
      context: {
        sessionId: args.sessionId,
        userId: args.userId,
        historyKey: args.historyKey,
        currentCwd,
      },
      agents: args.agents,
      state: {
        directoryManager: args.state.directoryManager,
        cacheKey: args.cacheKey,
        workspaceCache: args.state.workspaceCache,
        cwdStore: args.state.cwdStore,
        cwdStorePath: args.state.cwdStorePath,
        persistCwdStore: args.state.persistCwdStore,
      },
      sessions: {
        sessionManager: args.sessionManager,
        orchestrator,
        getWorkspaceLock: args.getWorkspaceLock,
        interruptControllers: args.interruptControllers,
      },
      history: {
        historyStore: args.historyStore,
      },
      commands: args.commands,
    });
    if (commandResult.handled) {
      currentCwd = commandResult.currentCwd;
      args.updateWorkspaceRootMeta(currentCwd);
      return {
        orchestrator: commandResult.orchestrator,
        currentCwd,
      };
    }

    args.safeJsonSend(args.ws, { type: "error", message: "Unsupported message type" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.warn(`[WebSocket] Message handler error: ${message}`);
    args.safeJsonSend(args.ws, { type: "error", message: "Internal server error" });
  }

  return { orchestrator, currentCwd };
}

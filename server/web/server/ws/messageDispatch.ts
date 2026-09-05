import type { WebSocket } from "ws";

import type { SessionManager } from "../../../sessions/sessionManager.js";
import { handleCommandMessage } from "./handleCommand.js";
import type {
  WsCommandHandlerDeps,
  WsCommandRuntimeDeps,
  WsHistoryRuntimeDeps,
  WsLaneValidityCheck,
  WsLogger,
  WsResetResult,
  WsRequestDeps,
  WsSchedulerDeps,
  WsSessionRuntimeDeps,
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
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: WsSessionRuntimeDeps["getWorkspaceLock"];
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  isLaneCurrent?: WsLaneValidityCheck;
  historyStore: WsHistoryRuntimeDeps["historyStore"];
  scheduler: WsSchedulerDeps;
  commands: WsCommandRuntimeDeps;
  agents: WsCommandHandlerDeps["agents"];
  state: Omit<WsCommandHandlerDeps["state"], "cacheKey"> & {
    broadcastSessionReset?: (payload: unknown) => void;
    resetLaneState?: () => WsResetResult;
    resetSharedSessionState?: (options: {
      sourceChatSessionId: string;
    }) => WsResetResult;
    closeAfterReset?: () => void;
  };
  registerSessionCacheBinding: () => void;
  broadcastJson: (payload: unknown) => void;
  safeJsonSend: (ws: WebSocket, payload: unknown) => void;
  sendWorkspaceState: (ws: WebSocket, workspaceRoot: string) => void;
  broadcastWorkspaceState?: (workspaceRoot: string) => void;
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
    if (args.isLaneCurrent && !args.isLaneCurrent() && args.msg.parsed.type !== "clear_history") {
      return { orchestrator, currentCwd };
    }
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
      chatSessionId: args.chatSessionId,
      userId: args.userId,
      historyKey: args.historyKey,
      currentCwd,
      sessionManager: args.sessionManager,
      orchestrator,
      getWorkspaceLock: args.getWorkspaceLock,
      historyStore: args.historyStore,
      interruptControllers: args.interruptControllers,
      promptRunEpochs: args.promptRunEpochs,
      isLaneCurrent: args.isLaneCurrent,
      sendJson: (payload) => args.safeJsonSend(args.ws, payload),
      broadcastJson: args.broadcastJson,
      broadcastSessionReset: args.state.broadcastSessionReset,
      resetLaneState: args.state.resetLaneState,
      resetSharedSessionState: args.state.resetSharedSessionState,
      closeAfterReset: args.state.closeAfterReset,
      logger: args.logger,
    });
    if (control.handled) {
      return { orchestrator: control.orchestrator, currentCwd };
    }
    if (args.isLaneCurrent && !args.isLaneCurrent()) {
      return { orchestrator, currentCwd };
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
        broadcastWorkspaceState: args.broadcastWorkspaceState,
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
        isLaneCurrent: args.isLaneCurrent,
      },
      sessions: {
        sessionManager: args.sessionManager,
        orchestrator,
        getWorkspaceLock: args.getWorkspaceLock,
        interruptControllers: args.interruptControllers,
        promptRunEpochs: args.promptRunEpochs,
      },
      history: {
        historyStore: args.historyStore,
      },
      scheduler: args.scheduler,
    });
    if (promptResult.handled) {
      return { orchestrator: promptResult.orchestrator, currentCwd };
    }
    if (args.isLaneCurrent && !args.isLaneCurrent()) {
      return { orchestrator, currentCwd };
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
        broadcastWorkspaceState: args.broadcastWorkspaceState,
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
          isLaneCurrent: args.isLaneCurrent,
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
        promptRunEpochs: args.promptRunEpochs,
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

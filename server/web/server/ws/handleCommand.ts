import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type {
  WsCommandHandlerDeps,
} from "./deps.js";
import { handleSetAgentCommand } from "./commandAgentSwitch.js";
import {
  handleBuiltinCommand,
  isBlockedUserSlashCommand,
  logCommandInput,
  parseCommandRequest,
} from "./commandBuiltins.js";
import { executeCommandLine } from "./commandExecution.js";

export async function handleCommandMessage(deps: WsCommandHandlerDeps): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  currentCwd: string;
}> {
  const sendToClient = (payload: unknown): void => deps.transport.safeJsonSend(deps.transport.ws, payload);
  const sendToChat = (payload: unknown): void => deps.transport.broadcastJson(payload);

  let orchestrator = deps.sessions.orchestrator;
  let currentCwd = deps.context.currentCwd;

  if (deps.request.parsed.type === "set_agent") {
    orchestrator = handleSetAgentCommand({
      payload: deps.request.parsed.payload,
      userId: deps.context.userId,
      currentCwd,
      orchestrator,
      sessionManager: deps.sessions.sessionManager,
      agentAvailability: deps.agents.agentAvailability,
      sendToClient,
    });

    return { handled: true, orchestrator, currentCwd };
  }

  if (deps.request.parsed.type !== "command") {
    return {
      handled: false,
      orchestrator,
      currentCwd,
    };
  }

  const lock = deps.sessions.getWorkspaceLock(detectWorkspaceFrom(currentCwd));
  await lock.runExclusive(async () => {
    const parsedCommand = parseCommandRequest({
      payload: deps.request.parsed.payload,
      sanitizeInput: deps.commands.sanitizeInput,
    });
    if (!parsedCommand.ok) {
      sendToClient({ type: "error", message: parsedCommand.message });
      return;
    }

    const commandRequest = parsedCommand.request;
    const sendToCommandScope = (payload: unknown): void =>
      (commandRequest.shouldBroadcast ? sendToChat(payload) : sendToClient(payload));

    if (!commandRequest.isSilentCommandPayload && commandRequest.normalizedSlash !== "cd") {
      logCommandInput({
        command: commandRequest.command,
        clientMessageId: deps.request.clientMessageId,
        historyKey: deps.context.historyKey,
        historyStore: deps.history.historyStore,
        sessionLogger: deps.observability.sessionLogger,
      });
    }

    const builtinResult = handleBuiltinCommand({
      request: commandRequest,
      userId: deps.context.userId,
      historyKey: deps.context.historyKey,
      currentCwd,
      orchestrator,
      state: deps.state,
      sessionManager: deps.sessions.sessionManager,
      historyStore: deps.history.historyStore,
      sendToCommandScope,
      transport: {
        ws: deps.transport.ws,
        sendWorkspaceState: deps.transport.sendWorkspaceState,
      },
      logger: deps.observability.logger,
      sessionLogger: deps.observability.sessionLogger,
      syncWorkspaceTemplates: deps.commands.syncWorkspaceTemplates,
    });
    currentCwd = builtinResult.currentCwd;
    orchestrator = builtinResult.orchestrator;
    if (builtinResult.handled) {
      return;
    }

    if (isBlockedUserSlashCommand(commandRequest.normalizedSlash)) {
      return;
    }

    await executeCommandLine({
      command: commandRequest.command,
      currentCwd,
      historyKey: deps.context.historyKey,
      historyStore: deps.history.historyStore,
      interruptControllers: deps.sessions.interruptControllers,
      runAdsCommandLine: deps.commands.runAdsCommandLine,
      sendToCommandScope,
      transport: {
        ws: deps.transport.ws,
        sendWorkspaceState: deps.transport.sendWorkspaceState,
      },
      logger: deps.observability.logger,
      sessionLogger: deps.observability.sessionLogger,
    });
  });

  return { handled: true, orchestrator, currentCwd };
}

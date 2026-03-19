import { parseSlashCommand } from "../../../codexConfig.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { withWorkspaceContext } from "../../../workspace/asyncWorkspaceContext.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type {
  WsCommandHandlerDeps,
} from "./deps.js";

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
    const payload = deps.request.parsed.payload;
    const agentId =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).agentId ?? "").trim()
        : "";

    if (!agentId) {
      sendToClient({ type: "error", message: "Payload must include agentId" });
      return { handled: true, orchestrator, currentCwd };
    }

    const switchResult = deps.sessions.sessionManager.switchAgent(deps.context.userId, agentId);
    if (!switchResult.success) {
      sendToClient({ type: "error", message: switchResult.message });
      return { handled: true, orchestrator, currentCwd };
    }

    orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, currentCwd);
    const activeAgentId = orchestrator.getActiveAgentId();
    sendToClient({
      type: "agents",
      activeAgentId,
      agents: orchestrator.listAgents().map((entry) => {
        const merged = deps.agents.agentAvailability.mergeStatus(entry.metadata.id, entry.status);
        return {
          id: entry.metadata.id,
          name: entry.metadata.name,
          ready: merged.ready,
          error: merged.error,
        };
      }),
      threadId: deps.sessions.sessionManager.getSavedThreadId(deps.context.userId, activeAgentId) ?? orchestrator.getThreadId(),
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
    const commandRaw = deps.commands.sanitizeInput(deps.request.parsed.payload);
    if (!commandRaw) {
      sendToClient({ type: "error", message: "Payload must be a command string" });
      return;
    }
    const command = commandRaw.trim();
    const isSilentCommandPayload =
      deps.request.parsed.payload !== null &&
      typeof deps.request.parsed.payload === "object" &&
      !Array.isArray(deps.request.parsed.payload) &&
      (deps.request.parsed.payload as Record<string, unknown>).silent === true;

    const slash = parseSlashCommand(command);
    const normalizedSlash = slash?.command?.toLowerCase();
    const isCdCommand = normalizedSlash === "cd";
    const shouldBroadcast = !isSilentCommandPayload && !isCdCommand;
    const sendToCommandScope = (payload: unknown): void => (shouldBroadcast ? sendToChat(payload) : sendToClient(payload));
    if (!isSilentCommandPayload && !isCdCommand) {
      deps.observability.sessionLogger?.logInput(command);
      if (!deps.request.clientMessageId) {
        deps.history.historyStore.add(deps.context.historyKey, {
          role: "user",
          text: command,
          ts: Date.now(),
        });
      }
    }

    if (slash?.command === "pwd") {
      const output = `当前工作目录: ${currentCwd}`;
      sendToCommandScope({ type: "result", ok: true, output });
      deps.observability.sessionLogger?.logOutput(output);
      deps.history.historyStore.add(deps.context.historyKey, { role: "status", text: output, ts: Date.now(), kind: "status" });
      return;
    }

    if (slash?.command === "cd") {
      if (!slash.body) {
        sendToCommandScope({ type: "result", ok: false, output: "用法: /cd <path>" });
        return;
      }
      const targetPath = slash.body;
      const prevCwd = currentCwd;
      const result = deps.state.directoryManager.setUserCwd(deps.context.userId, targetPath);
      if (!result.success) {
        const output = `错误: ${result.error}`;
        sendToCommandScope({ type: "result", ok: false, output });
        deps.observability.sessionLogger?.logError(output);
        return;
      }
      currentCwd = deps.state.directoryManager.getUserCwd(deps.context.userId);
      deps.state.workspaceCache.set(deps.state.cacheKey, currentCwd);
      deps.state.cwdStore.set(String(deps.context.userId), currentCwd);
      deps.state.persistCwdStore(deps.state.cwdStorePath, deps.state.cwdStore);
      deps.sessions.sessionManager.setUserCwd(deps.context.userId, currentCwd);
      try {
        deps.commands.syncWorkspaceTemplates();
      } catch (error) {
        deps.observability.logger.warn(`[Web] Failed to sync templates after cd: ${(error as Error).message}`);
      }
      orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, currentCwd);

      let message = `已切换到: ${currentCwd}`;
      if (prevCwd !== currentCwd) {
        message += "\n提示: 代理上下文已切换到新目录";
      } else {
        message += "\n提示: 已在相同目录，无需重置会话";
      }
      if (!isSilentCommandPayload) {
        sendToCommandScope({ type: "result", ok: true, output: message });
        deps.observability.sessionLogger?.logOutput(message);
      }
      deps.transport.sendWorkspaceState(deps.transport.ws, currentCwd);
      return;
    }

    const isBlockedUserSlashCommand =
      typeof normalizedSlash === "string" &&
      (normalizedSlash === "search" ||
        normalizedSlash === "bootstrap" ||
        normalizedSlash === "vsearch" ||
        normalizedSlash === "review" ||
        normalizedSlash === "ads" ||
        normalizedSlash.startsWith("ads."));
    if (isBlockedUserSlashCommand) {
      return;
    }

    const controller = new AbortController();
    deps.sessions.interruptControllers.set(deps.context.historyKey, controller);

    let runPromise: Promise<{ ok: boolean; output: string }> | undefined;
    try {
      runPromise = withWorkspaceContext(currentCwd, () => deps.commands.runAdsCommandLine(command));
      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("用户中断"));
          },
          { once: true },
        );
      });
      const result = await Promise.race([runPromise, abortPromise]);
      sendToCommandScope({ type: "result", ok: result.ok, output: result.output });
      deps.observability.sessionLogger?.logOutput(result.output);
      deps.history.historyStore.add(deps.context.historyKey, {
        role: result.ok ? "ai" : "status",
        text: result.output,
        ts: Date.now(),
        kind: result.ok ? undefined : "command",
      });
      deps.transport.sendWorkspaceState(deps.transport.ws, currentCwd);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = (error as Error).message ?? String(error);
      if (aborted) {
        if (runPromise) {
          void runPromise.catch((innerError) => {
            const detail = innerError instanceof Error ? innerError.message : String(innerError);
            deps.observability.logger.debug(`[Web] runAdsCommandLine settled after abort: ${detail}`);
          });
        }
        sendToCommandScope({ type: "error", message: "已中断，输出可能不完整" });
        deps.observability.sessionLogger?.logError("已中断，输出可能不完整");
      } else {
        sendToCommandScope({ type: "error", message });
        deps.observability.sessionLogger?.logError(message);
      }
    } finally {
      deps.sessions.interruptControllers.delete(deps.context.historyKey);
    }
  });

  return { handled: true, orchestrator, currentCwd };
}

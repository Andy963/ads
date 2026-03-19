import type { WebSocket } from "ws";

import { parseSlashCommand } from "../../../codexConfig.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { withWorkspaceContext } from "../../../workspace/asyncWorkspaceContext.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { WsMessage } from "./schema.js";

export async function handleCommandMessage(deps: {
  parsed: WsMessage;
  ws: WebSocket;
  safeJsonSend: (ws: WebSocket, payload: unknown) => void;
  broadcastJson: (payload: unknown) => void;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
  sessionLogger: { logInput: (text: string) => void; logOutput: (text: string) => void; logError: (text: string) => void } | null;
  requestId: string;
  sessionId: string;
  userId: number;
  historyKey: string;
  clientMessageId: string | null;
  traceWsDuplication: boolean;
  directoryManager: DirectoryManager;
  cacheKey: string;
  workspaceCache: Map<string, string>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: (storePath: string, store: Map<string, string>) => void;
  sessionManager: SessionManager;
  agentAvailability: AgentAvailability;
  historyStore: HistoryStore;
  interruptControllers: Map<string, AbortController>;
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sendWorkspaceState: (ws: WebSocket, workspaceRoot: string) => void;
  syncWorkspaceTemplates: () => void;
  sanitizeInput: (payload: unknown) => string;
  currentCwd: string;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  currentCwd: string;
}> {
  const sendToClient = (payload: unknown): void => deps.safeJsonSend(deps.ws, payload);
  const sendToChat = (payload: unknown): void => deps.broadcastJson(payload);

  let orchestrator = deps.orchestrator;
  let currentCwd = deps.currentCwd;

  if (deps.parsed.type === "set_agent") {
    const payload = deps.parsed.payload;
    const agentId =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).agentId ?? "").trim()
        : "";

    if (!agentId) {
      sendToClient({ type: "error", message: "Payload must include agentId" });
      return { handled: true, orchestrator, currentCwd };
    }

    const switchResult = deps.sessionManager.switchAgent(deps.userId, agentId);
    if (!switchResult.success) {
      sendToClient({ type: "error", message: switchResult.message });
      return { handled: true, orchestrator, currentCwd };
    }

    orchestrator = deps.sessionManager.getOrCreate(deps.userId, currentCwd);
    const activeAgentId = orchestrator.getActiveAgentId();
    sendToClient({
      type: "agents",
      activeAgentId,
      agents: orchestrator.listAgents().map((entry) => {
        const merged = deps.agentAvailability.mergeStatus(entry.metadata.id, entry.status);
        return {
          id: entry.metadata.id,
          name: entry.metadata.name,
          ready: merged.ready,
          error: merged.error,
        };
      }),
      threadId: deps.sessionManager.getSavedThreadId(deps.userId, activeAgentId) ?? orchestrator.getThreadId(),
    });
    return { handled: true, orchestrator, currentCwd };
  }

  if (deps.parsed.type !== "command") {
    return {
      handled: false,
      orchestrator,
      currentCwd,
    };
  }

  const lock = deps.getWorkspaceLock(detectWorkspaceFrom(currentCwd));
  await lock.runExclusive(async () => {
    const commandRaw = deps.sanitizeInput(deps.parsed.payload);
    if (!commandRaw) {
      sendToClient({ type: "error", message: "Payload must be a command string" });
      return;
    }
    const command = commandRaw.trim();
    const isSilentCommandPayload =
      deps.parsed.payload !== null &&
      typeof deps.parsed.payload === "object" &&
      !Array.isArray(deps.parsed.payload) &&
      (deps.parsed.payload as Record<string, unknown>).silent === true;

    const slash = parseSlashCommand(command);
    const normalizedSlash = slash?.command?.toLowerCase();
    const isCdCommand = normalizedSlash === "cd";
    const shouldBroadcast = !isSilentCommandPayload && !isCdCommand;
    const sendToCommandScope = (payload: unknown): void => (shouldBroadcast ? sendToChat(payload) : sendToClient(payload));
    if (!isSilentCommandPayload && !isCdCommand) {
      deps.sessionLogger?.logInput(command);
      if (!deps.clientMessageId) {
        deps.historyStore.add(deps.historyKey, {
          role: "user",
          text: command,
          ts: Date.now(),
        });
      }
    }

    if (slash?.command === "pwd") {
      const output = `当前工作目录: ${currentCwd}`;
      sendToCommandScope({ type: "result", ok: true, output });
      deps.sessionLogger?.logOutput(output);
      deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "status" });
      return;
    }

    if (slash?.command === "cd") {
      if (!slash.body) {
        sendToCommandScope({ type: "result", ok: false, output: "用法: /cd <path>" });
        return;
      }
      const targetPath = slash.body;
      const prevCwd = currentCwd;
      const result = deps.directoryManager.setUserCwd(deps.userId, targetPath);
      if (!result.success) {
        const output = `错误: ${result.error}`;
        sendToCommandScope({ type: "result", ok: false, output });
        deps.sessionLogger?.logError(output);
        return;
      }
      currentCwd = deps.directoryManager.getUserCwd(deps.userId);
      deps.workspaceCache.set(deps.cacheKey, currentCwd);
      deps.cwdStore.set(String(deps.userId), currentCwd);
      deps.persistCwdStore(deps.cwdStorePath, deps.cwdStore);
      deps.sessionManager.setUserCwd(deps.userId, currentCwd);
      try {
        deps.syncWorkspaceTemplates();
      } catch (error) {
        deps.logger.warn(`[Web] Failed to sync templates after cd: ${(error as Error).message}`);
      }
      orchestrator = deps.sessionManager.getOrCreate(deps.userId, currentCwd);

      let message = `已切换到: ${currentCwd}`;
      if (prevCwd !== currentCwd) {
        message += "\n提示: 代理上下文已切换到新目录";
      } else {
        message += "\n提示: 已在相同目录，无需重置会话";
      }
      if (!isSilentCommandPayload) {
        sendToCommandScope({ type: "result", ok: true, output: message });
        deps.sessionLogger?.logOutput(message);
      }
      deps.sendWorkspaceState(deps.ws, currentCwd);
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
    deps.interruptControllers.set(deps.historyKey, controller);

    let runPromise: Promise<{ ok: boolean; output: string }> | undefined;
    try {
      runPromise = withWorkspaceContext(currentCwd, () => deps.runAdsCommandLine(command));
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
      deps.sessionLogger?.logOutput(result.output);
      deps.historyStore.add(deps.historyKey, {
        role: result.ok ? "ai" : "status",
        text: result.output,
        ts: Date.now(),
        kind: result.ok ? undefined : "command",
      });
      deps.sendWorkspaceState(deps.ws, currentCwd);
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = (error as Error).message ?? String(error);
      if (aborted) {
        if (runPromise) {
          void runPromise.catch((innerError) => {
            const detail = innerError instanceof Error ? innerError.message : String(innerError);
            deps.logger.debug(`[Web] runAdsCommandLine settled after abort: ${detail}`);
          });
        }
        sendToCommandScope({ type: "error", message: "已中断，输出可能不完整" });
        deps.sessionLogger?.logError("已中断，输出可能不完整");
      } else {
        sendToCommandScope({ type: "error", message });
        deps.sessionLogger?.logError(message);
      }
    } finally {
      deps.interruptControllers.delete(deps.historyKey);
    }
  });

  return { handled: true, orchestrator, currentCwd };
}

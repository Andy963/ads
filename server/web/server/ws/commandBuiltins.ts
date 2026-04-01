import { parseSlashCommand } from "../../../codexConfig.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsCommandStateDeps, WsLogger, WsOrchestrator, WsSessionLogger, WsTransportDeps } from "./deps.js";

type SlashCommand = ReturnType<typeof parseSlashCommand>;

export type WsParsedCommandRequest = {
  command: string;
  slash: SlashCommand;
  normalizedSlash?: string;
  isSilentCommandPayload: boolean;
  shouldBroadcast: boolean;
};

export function parseCommandRequest(args: {
  payload: unknown;
  sanitizeInput: (payload: unknown) => string;
}): { ok: false; message: string } | { ok: true; request: WsParsedCommandRequest } {
  const commandRaw = args.sanitizeInput(args.payload);
  if (!commandRaw) {
    return { ok: false, message: "Payload must be a command string" };
  }

  const command = commandRaw.trim();
  const isSilentCommandPayload =
    args.payload !== null &&
    typeof args.payload === "object" &&
    !Array.isArray(args.payload) &&
    (args.payload as Record<string, unknown>).silent === true;

  const slash = parseSlashCommand(command);
  const normalizedSlash = slash?.command?.toLowerCase();
  const isCdCommand = normalizedSlash === "cd";

  return {
    ok: true,
    request: {
      command,
      slash,
      normalizedSlash,
      isSilentCommandPayload,
      shouldBroadcast: !isSilentCommandPayload && !isCdCommand,
    },
  };
}

export function isBlockedUserSlashCommand(normalizedSlash?: string): boolean {
  return Boolean(
    typeof normalizedSlash === "string" &&
      (normalizedSlash === "search" ||
        normalizedSlash === "bootstrap" ||
        normalizedSlash === "vsearch" ||
        normalizedSlash === "review" ||
        normalizedSlash === "ads" ||
        normalizedSlash.startsWith("ads.")),
  );
}

export function logCommandInput(args: {
  command: string;
  clientMessageId: string | null;
  historyKey: string;
  historyStore: HistoryStore;
  sessionLogger: WsSessionLogger;
}): void {
  args.sessionLogger?.logInput(args.command);
  if (!args.clientMessageId) {
    args.historyStore.add(args.historyKey, {
      role: "user",
      text: args.command,
      ts: Date.now(),
    });
  }
}

export function handleBuiltinCommand(args: {
  request: WsParsedCommandRequest;
  userId: number;
  historyKey: string;
  currentCwd: string;
  orchestrator: WsOrchestrator;
  state: WsCommandStateDeps;
  sessionManager: SessionManager;
  historyStore: HistoryStore;
  sendToCommandScope: (payload: unknown) => void;
  transport: Pick<WsTransportDeps, "ws" | "sendWorkspaceState">;
  logger: WsLogger;
  sessionLogger: WsSessionLogger;
  syncWorkspaceTemplates: () => void;
}): {
  handled: boolean;
  currentCwd: string;
  orchestrator: WsOrchestrator;
} {
  if (args.request.slash?.command === "pwd") {
    const output = `当前工作目录: ${args.currentCwd}`;
    args.sendToCommandScope({ type: "result", ok: true, output });
    args.sessionLogger?.logOutput(output);
    args.historyStore.add(args.historyKey, { role: "status", text: output, ts: Date.now(), kind: "status" });
    return {
      handled: true,
      currentCwd: args.currentCwd,
      orchestrator: args.orchestrator,
    };
  }

  if (args.request.slash?.command !== "cd") {
    return {
      handled: false,
      currentCwd: args.currentCwd,
      orchestrator: args.orchestrator,
    };
  }

  if (!args.request.slash.body) {
    args.sendToCommandScope({ type: "result", ok: false, output: "用法: /cd <path>" });
    return {
      handled: true,
      currentCwd: args.currentCwd,
      orchestrator: args.orchestrator,
    };
  }

  const prevCwd = args.currentCwd;
  const result = args.state.directoryManager.setUserCwd(args.userId, args.request.slash.body);
  if (!result.success) {
    const output = `错误: ${result.error}`;
    args.sendToCommandScope({ type: "result", ok: false, output });
    args.sessionLogger?.logError(output);
    return {
      handled: true,
      currentCwd: args.currentCwd,
      orchestrator: args.orchestrator,
    };
  }

  const currentCwd = args.state.directoryManager.getUserCwd(args.userId);
  args.state.workspaceCache.set(args.state.cacheKey, currentCwd);
  args.state.cwdStore.set(String(args.userId), currentCwd);
  args.state.persistCwdStore(args.state.cwdStorePath, args.state.cwdStore);
  args.sessionManager.setUserCwd(args.userId, currentCwd);
  try {
    args.syncWorkspaceTemplates();
  } catch (error) {
    args.logger.warn(`[Web] Failed to sync templates after cd: ${(error as Error).message}`);
  }
  const orchestrator = args.sessionManager.getOrCreate(args.userId, currentCwd);

  let message = `已切换到: ${currentCwd}`;
  if (prevCwd !== currentCwd) {
    message += "\n提示: 代理上下文已切换到新目录";
  } else {
    message += "\n提示: 已在相同目录，无需重置会话";
  }
  if (!args.request.isSilentCommandPayload) {
    args.sendToCommandScope({ type: "result", ok: true, output: message });
    args.sessionLogger?.logOutput(message);
  }
  args.transport.sendWorkspaceState(args.transport.ws, currentCwd);

  return {
    handled: true,
    currentCwd,
    orchestrator,
  };
}

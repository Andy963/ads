import type { WebSocket } from "ws";

import { SearchTool } from "../../../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../../../tools/search/config.js";
import { formatSearchResults } from "../../../tools/search/format.js";
import { formatLocalSearchOutput, searchWorkspaceFiles } from "../../../utils/localSearch.js";
import { parseSlashCommand } from "../../../codexConfig.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { withWorkspaceContext } from "../../../workspace/asyncWorkspaceContext.js";
import { runVectorSearch } from "../../../vectorSearch/run.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
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
  historyStore: HistoryStore;
  interruptControllers: Map<WebSocket, AbortController>;
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
  if (deps.parsed.type !== "command") {
    return {
      handled: false,
      orchestrator: deps.orchestrator,
      currentCwd: deps.currentCwd,
    };
  }

  const sendToClient = (payload: unknown): void => deps.safeJsonSend(deps.ws, payload);
  const sendToChat = (payload: unknown): void => deps.broadcastJson(payload);

  let orchestrator = deps.orchestrator;
  let currentCwd = deps.currentCwd;

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
      const entryKind = deps.clientMessageId ? `client_message_id:${deps.clientMessageId}` : undefined;
      const inserted = deps.historyStore.add(deps.historyKey, {
        role: "user",
        text: command,
        ts: Date.now(),
        kind: entryKind,
      });
      if (deps.clientMessageId) {
        sendToClient({ type: "ack", client_message_id: deps.clientMessageId, duplicate: !inserted });
        if (!inserted) {
          if (deps.traceWsDuplication) {
            deps.logger.warn(
              `[WebSocket][Dedupe] req=${deps.requestId} session=${deps.sessionId} user=${deps.userId} history=${deps.historyKey} client_message_id=${deps.clientMessageId}`,
            );
          }
          return;
        }
      }
    }

    if (slash?.command === "vsearch") {
      const query = slash.body.trim();
      const workspaceRoot = detectWorkspaceFrom(currentCwd);
      const output = await runVectorSearch({ workspaceRoot, query, entryNamespace: "web" });
      const note = "提示：系统会在后台自动用向量召回来补齐 agent 上下文；/vsearch 主要用于手动调试/查看原始召回结果。";
      const decorated = output.startsWith("Vector search results for:") ? `${note}\n\n${output}` : output;
      sendToCommandScope({ type: "result", ok: true, output: decorated });
      deps.sessionLogger?.logOutput(decorated);
      deps.historyStore.add(deps.historyKey, { role: "ai", text: decorated, ts: Date.now() });
      return;
    }
    if (slash?.command === "search") {
      const query = slash.body.trim();
      if (!query) {
        const output = "用法: /search <query>";
        sendToCommandScope({ type: "result", ok: false, output });
        deps.sessionLogger?.logError(output);
        deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
        return;
      }
      const config = resolveSearchConfig();
      const missingKeys = ensureApiKeys(config);
      if (missingKeys) {
        const workspaceRoot = detectWorkspaceFrom(currentCwd);
        const local = searchWorkspaceFiles({ workspaceRoot, query });
        const output = formatLocalSearchOutput({ query, ...local });
        sendToCommandScope({ type: "result", ok: true, output });
        deps.sessionLogger?.logOutput(output);
        deps.historyStore.add(deps.historyKey, { role: "ai", text: output, ts: Date.now() });
        return;
      }
      try {
        const result = await SearchTool.search({ query }, { config });
        const output = formatSearchResults(query, result);
        sendToCommandScope({ type: "result", ok: true, output });
        deps.sessionLogger?.logOutput(output);
        deps.historyStore.add(deps.historyKey, { role: "ai", text: output, ts: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const output = `/search 失败: ${message}`;
        sendToCommandScope({ type: "result", ok: false, output });
        deps.sessionLogger?.logError(output);
        deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
      }
      return;
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

    if (slash?.command === "agent") {
      orchestrator = deps.sessionManager.getOrCreate(deps.userId, currentCwd);
      const sendAgentsSnapshot = () => {
        const activeAgentId = orchestrator.getActiveAgentId();
        sendToCommandScope({
          type: "agents",
          activeAgentId,
          agents: orchestrator.listAgents().map((entry) => ({
            id: entry.metadata.id,
            name: entry.metadata.name,
            ready: entry.status.ready,
            error: entry.status.error,
          })),
          threadId: deps.sessionManager.getSavedThreadId(deps.userId, activeAgentId) ?? orchestrator.getThreadId(),
        });
      };
      let agentArg = slash.body.trim();
      if (!agentArg) {
        if (isSilentCommandPayload) {
          sendAgentsSnapshot();
          return;
        }
        const agents = orchestrator.listAgents();
        if (agents.length === 0) {
          const output = "暂无可用代理";
          sendToCommandScope({ type: "result", ok: false, output });
          deps.sessionLogger?.logOutput(output);
          return;
        }
        const activeId = orchestrator.getActiveAgentId();
        const lines = agents
          .map((entry: { metadata: { id: string; name: string }; status: { ready: boolean; error?: string } }) => {
            const marker = entry.metadata.id === activeId ? "•" : "○";
            const state = entry.status.ready ? "可用" : entry.status.error ?? "未配置";
            return `${marker} ${entry.metadata.name} (${entry.metadata.id}) - ${state}`;
          })
          .join("\n");
        const message = [
          "🤖 可用代理：",
          lines,
          "",
          "使用 /agent <id> 切换代理，如 /agent gemini。",
          "提示：当主代理为 Codex 时，会在需要前端/文案等场景自动调用 Claude/Gemini 协作并整合验收。",
        ].join("\n");
        sendToCommandScope({ type: "result", ok: true, output: message });
        deps.sessionLogger?.logOutput(message);
        sendAgentsSnapshot();
        return;
      }
      const normalized = agentArg.toLowerCase();
      if (normalized === "auto" || normalized === "manual") {
        agentArg = "codex";
      }
      const switchResult = deps.sessionManager.switchAgent(deps.userId, agentArg);
      if (isSilentCommandPayload) {
        if (switchResult.success) {
          sendAgentsSnapshot();
        } else {
          sendToCommandScope({ type: "error", message: switchResult.message });
          deps.sessionLogger?.logError(switchResult.message);
        }
        return;
      }
      sendToCommandScope({ type: "result", ok: switchResult.success, output: switchResult.message });
      deps.sessionLogger?.logOutput(switchResult.message);
      if (switchResult.success) {
        sendAgentsSnapshot();
      }
      return;
    }

    let commandToExecute = command;
    if (slash?.command === "review") {
      commandToExecute = `/ads.review${slash.body ? ` ${slash.body}` : ""}`;
    }

    const controller = new AbortController();
    deps.interruptControllers.set(deps.ws, controller);

    let runPromise: Promise<{ ok: boolean; output: string }> | undefined;
    try {
      runPromise = withWorkspaceContext(currentCwd, () => deps.runAdsCommandLine(commandToExecute));
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
      deps.interruptControllers.delete(deps.ws);
    }
  });

  return { handled: true, orchestrator, currentCwd };
}

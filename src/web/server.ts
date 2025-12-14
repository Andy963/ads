import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";
import { z } from "zod";
import type {
  CommandExecutionItem,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ThreadEvent,
  TodoListItem,
} from "@openai/codex-sdk";

import "../utils/logSink.js";
import "../utils/env.js";
import { runAdsCommandLine } from "./commandRouter.js";
import { detectWorkspace } from "../workspace/detector.js";
import { DirectoryManager } from "../telegram/utils/directoryManager.js";
import { checkWorkspaceInit } from "../telegram/utils/workspaceInitChecker.js";
import { createLogger } from "../utils/logger.js";
import type { AgentEvent } from "../codex/events.js";
import { parseSlashCommand } from "../codexConfig.js";
import { SessionManager } from "../telegram/utils/sessionManager.js";
import { ThreadStorage } from "../telegram/utils/threadStorage.js";
import { runCollaborativeTurn } from "../agents/hub.js";
import { resolveToolInvocations } from "../agents/tools.js";
import { syncWorkspaceTemplates } from "../workspace/service.js";
import { HistoryStore } from "../utils/historyStore.js";

import { renderLandingPage as renderLandingPageTemplate } from "./landingPage.js";

import {
  loadCwdStore,
  persistCwdStore,
  isProcessRunning,
  isLikelyWebProcess,
  wait,
  deriveWebUserId,
  truncateForLog,
  resolveAllowedDirs,
  sanitizeInput,
  getWorkspaceState,
  buildPromptInput,
  cleanupTempFiles,
  buildUserLogEntry,
} from "./utils.js";

const PORT = Number(process.env.ADS_WEB_PORT) || 8787;
const HOST = process.env.ADS_WEB_HOST || "0.0.0.0";
const TOKEN = (process.env.ADS_WEB_TOKEN ?? "").trim();
const MAX_CLIENTS = Math.max(1, Number(process.env.ADS_WEB_MAX_CLIENTS ?? 1));
const IDLE_MINUTES = Math.max(1, Number(process.env.ADS_WEB_IDLE_MINUTES ?? 15));
const logger = createLogger("WebSocket");

// Cache last workspace per client token to persist cwd across reconnects (process memory only)
const workspaceCache = new Map<string, string>();
const interruptControllers = new Map<number, AbortController>();
const webThreadStorage = new ThreadStorage({
  namespace: "web",
  storagePath: path.join(process.cwd(), ".ads", "web-threads.json"),
});
const sessionManager = new SessionManager(undefined, undefined, "workspace-write", undefined, webThreadStorage);
const historyStore = new HistoryStore({
  storagePath: path.join(process.cwd(), ".ads", "state.db"),
  namespace: "web",
  migrateFromPaths: [path.join(process.cwd(), ".ads", "web-history.json")],
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = path.join(process.cwd(), ".ads", "web-cwd.json");
const cwdStore = loadCwdStore(cwdStorePath);

const wsMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
});

function log(...args: unknown[]): void {
  logger.info(args.map((a) => String(a)).join(" "));
}

type TodoListThreadEvent = (ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent) & {
  item: TodoListItem;
};

function isTodoListEvent(event: ThreadEvent): event is TodoListThreadEvent {
  if (!event || (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed")) {
    return false;
  }
  return (event as ItemStartedEvent).item?.type === "todo_list";
}

function buildPlanSignature(items: TodoListItem["items"]): string {
  return items.map((entry) => `${entry.completed ? "1" : "0"}:${entry.text}`).join("|");
}

async function ensureWebPidFile(workspaceRoot: string): Promise<string> {
  const runDir = path.join(workspaceRoot, ".ads", "run");
  fs.mkdirSync(runDir, { recursive: true });
  const pidFile = path.join(runDir, "web.pid");

  const existing = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
  const existingPid = Number.parseInt(existing, 10);

  if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
    if (isProcessRunning(existingPid)) {
      if (isLikelyWebProcess(existingPid)) {
        log(`terminating existing web server pid ${existingPid} from ${pidFile}`);
        try {
          process.kill(existingPid, "SIGTERM");
        } catch (error) {
          log(`failed to terminate pid ${existingPid}: ${(error as Error).message}`);
        }
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && isProcessRunning(existingPid)) {
          await wait(100);
        }
      } else {
        log(`pid file ${pidFile} points to pid ${existingPid}, but command line is different; leaving it running`);
      }
    } else {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* noop */
      }
    }
  }

  fs.writeFileSync(pidFile, String(process.pid));
  const cleanup = (): void => {
    try {
      const recorded = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
      if (recorded === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      /* noop */
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  return pidFile;
}

function createHttpServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      if (req.url?.startsWith("/healthz")) {
        res.writeHead(200).end("ok");
        return;
      }
      // 任何 GET 路径统一返回控制台，便于反代子路径
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLandingPage());
      return;
    }
    res.writeHead(404).end("Not Found");
  });
  return server;
}

function extractCommandPayload(
  event: AgentEvent,
): { id?: string; command?: string; status?: string; exit_code?: number; aggregated_output?: string } | null {
  const raw = event.raw as { type?: string; item?: CommandExecutionItem };
  if (!raw || typeof raw !== "object") return null;
  if (!["item.started", "item.updated", "item.completed"].includes(raw.type ?? "")) {
    return null;
  }
  const item = raw.item;
  if (!item || (item as CommandExecutionItem).type !== "command_execution") {
    return null;
  }
  const cmd = item as CommandExecutionItem;
  return {
    id: cmd.id,
    command: cmd.command,
    status: cmd.status,
    exit_code: cmd.exit_code,
    aggregated_output: cmd.aggregated_output,
  };
}

function sendWorkspaceState(ws: WebSocket, workspaceRoot: string): void {
  try {
    const state = getWorkspaceState(workspaceRoot);
    ws.send(JSON.stringify({ type: "workspace", data: state }));
  } catch {
    // ignore send errors
  }
}

function renderLandingPage(): string {
  return renderLandingPageTemplate({ idleMinutes: IDLE_MINUTES });
}


async function start(): Promise<void> {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server });

  const workspaceRoot = detectWorkspace();
  try {
    syncWorkspaceTemplates();
  } catch (error) {
    logger.warn(`[Web] Failed to sync templates: ${(error as Error).message}`);
  }
  await ensureWebPidFile(workspaceRoot);
  const allowedDirs = resolveAllowedDirs(workspaceRoot);
  const clients: Set<WebSocket> = new Set();

  wss.on("connection", (ws: WebSocket, req) => {
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const parsedProtocols =
      Array.isArray(protocolHeader) && protocolHeader.length > 0
        ? protocolHeader
        : typeof protocolHeader === "string"
          ? protocolHeader.split(",").map((p) => p.trim())
          : [];

    const parseProtocols = (protocols: string[]): { token?: string; session?: string } => {
      let token: string | undefined;
      let session: string | undefined;

      for (let i = 0; i < protocols.length; i++) {
        const entry = protocols[i];
        if (entry.startsWith("ads-token:")) {
          token = entry.split(":").slice(1).join(":");
          continue;
        }
        if (entry === "ads-token" && i + 1 < protocols.length) {
          token = protocols[i + 1];
          continue;
        }
        if (entry.startsWith("ads-session:")) {
          session = entry.split(":").slice(1).join(":");
          continue;
        }
        if (entry === "ads-session" && i + 1 < protocols.length) {
          session = protocols[i + 1];
        }
      }
      return { token, session };
    };

    const { token: wsToken, session: wsSession } = parseProtocols(parsedProtocols);
    const sessionId = wsSession && wsSession.trim() ? wsSession.trim() : crypto.randomBytes(4).toString("hex");
    if (TOKEN && wsToken !== TOKEN) {
      ws.close(4401, "unauthorized");
      return;
    }

    if (clients.size >= MAX_CLIENTS) {
      ws.close(4409, `max clients reached (${MAX_CLIENTS})`);
      return;
    }
    clients.add(ws);

    const clientKey = wsToken && wsToken.length > 0 ? wsToken : "default";
    const userId = deriveWebUserId(clientKey, sessionId);
    const historyKey = `${clientKey}::${sessionId}`;
    const directoryManager = new DirectoryManager(allowedDirs);

    const cacheKey = `${clientKey}::${sessionId}`;
    const cachedWorkspace = workspaceCache.get(cacheKey);
    const savedState = sessionManager.getSavedState(userId);
    const storedCwd = cwdStore.get(String(userId));
    let currentCwd = directoryManager.getUserCwd(userId);
    const preferredCwd = cachedWorkspace ?? savedState?.cwd ?? storedCwd;
    if (preferredCwd) {
      const restoreResult = directoryManager.setUserCwd(userId, preferredCwd);
      if (!restoreResult.success) {
        logger.warn(`[Web][WorkspaceRestore] failed path=${preferredCwd} reason=${restoreResult.error}`);
      } else {
        currentCwd = directoryManager.getUserCwd(userId);
        cwdStore.set(String(userId), currentCwd);
        persistCwdStore(cwdStorePath, cwdStore);
      }
    }
    workspaceCache.set(cacheKey, currentCwd);
    sessionManager.setUserCwd(userId, currentCwd);
    cwdStore.set(String(userId), currentCwd);
    persistCwdStore(cwdStorePath, cwdStore);

    const resumeThread = !sessionManager.hasSession(userId);
    let orchestrator = sessionManager.getOrCreate(userId, currentCwd, resumeThread);
    let lastPlanSignature: string | null = null;

    log("client connected");
    ws.send(
      JSON.stringify({
        type: "welcome",
        message: "ADS WebSocket bridge ready. Send {type:'command', payload:'/ads.status'}",
        workspace: getWorkspaceState(currentCwd),
        sessionId,
      }),
    );
    const cachedHistory = historyStore.get(historyKey);
    if (cachedHistory.length > 0) {
      ws.send(JSON.stringify({ type: "history", items: cachedHistory }));
    }

    ws.on("message", async (data: RawData) => {
      let parsed: z.infer<typeof wsMessageSchema>;
      try {
        const raw = JSON.parse(String(data)) as unknown;
        const result = wsMessageSchema.safeParse(raw);
        if (!result.success) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid message payload" }));
          return;
        }
        parsed = result.data;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
        return;
      }

        const sessionLogger = sessionManager.ensureLogger(userId);
        const isPrompt = parsed.type === "prompt";
        const isCommand = parsed.type === "command";
        const isInterrupt = parsed.type === "interrupt";

        if (isInterrupt) {
          const controller = interruptControllers.get(userId);
          if (controller) {
            controller.abort();
            interruptControllers.delete(userId);
            ws.send(JSON.stringify({ type: "result", ok: false, output: "⛔ 已中断，输出可能不完整" }));
          } else {
            ws.send(JSON.stringify({ type: "error", message: "当前没有正在执行的任务" }));
          }
          return;
        }

        if (parsed.type === "clear_history") {
          historyStore.clear(historyKey);
          ws.send(JSON.stringify({ type: "result", ok: true, output: "已清空历史缓存" }));
          return;
        }

        if (isPrompt) {
          const imageDir = path.join(currentCwd, ".ads", "temp", "web-images");
          const promptInput = buildPromptInput(parsed.payload, imageDir);
          if (!promptInput.ok) {
            sessionLogger?.logError(promptInput.message);
            ws.send(JSON.stringify({ type: "error", message: promptInput.message }));
            return;
          }
          const tempAttachments = promptInput.attachments || [];
          const cleanupAttachments = () => cleanupTempFiles(tempAttachments);
          // 清空本轮的计划签名，等待新的 todo_list
          lastPlanSignature = null;
          const userLogEntry = sessionLogger ? buildUserLogEntry(promptInput.input, currentCwd) : null;
          if (sessionLogger && userLogEntry) {
            sessionLogger.logInput(userLogEntry);
          }
          if (userLogEntry) {
            historyStore.add(historyKey, { role: "user", text: userLogEntry, ts: Date.now() });
          }
          const controller = new AbortController();
          interruptControllers.set(userId, controller);
          orchestrator = sessionManager.getOrCreate(userId, currentCwd);
          const status = orchestrator.status();
          if (!status.ready) {
            sessionLogger?.logError(status.error ?? "代理未启用");
            ws.send(JSON.stringify({ type: "error", message: status.error ?? "代理未启用，请配置凭证" }));
            interruptControllers.delete(userId);
            cleanupAttachments();
            return;
          }
          orchestrator.setWorkingDirectory(currentCwd);
          const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
            sessionLogger?.logEvent(event);
            logger.debug(`[Event] phase=${event.phase} title=${event.title} detail=${event.detail?.slice(0, 50)}`);
            const raw = event.raw as ThreadEvent;
            if (isTodoListEvent(raw)) {
              const signature = buildPlanSignature(raw.item.items);
              if (signature !== lastPlanSignature) {
                lastPlanSignature = signature;
                ws.send(JSON.stringify({ type: "plan", items: raw.item.items }));
                historyStore.add(historyKey, {
                  role: "status",
                  text: `计划更新：${raw.item.items
                    .map((entry, idx) => `${entry.completed ? "✅" : "⬜"} ${entry.text || `Step ${idx + 1}`}`)
                    .join(" | ")}`,
                  ts: Date.now(),
                  kind: "plan",
                });
              }
            }
            if (event.delta) {
              // 协作回合可能触发多轮 agent_message；避免前端收到混杂的增量内容
              return;
            }
            if (event.phase === "command") {
              const commandPayload = extractCommandPayload(event);
              logger.info(`[Command Event] sending command: ${JSON.stringify({ detail: event.detail ?? event.title, command: commandPayload })}`);
              ws.send(
                JSON.stringify({
                  type: "command",
                  detail: event.detail ?? event.title,
                  command: commandPayload ?? undefined,
                }),
              );
              return;
            }
            if (event.phase === "error") {
              ws.send(JSON.stringify({ type: "error", message: event.detail ?? event.title }));
            }
          });
          try {
            const result = await runCollaborativeTurn(orchestrator, promptInput.input, {
              streaming: true,
              signal: controller.signal,
              hooks: {
                onSupervisorRound: (round, directives) =>
                  logger.info(`[Auto] supervisor round=${round} directives=${directives}`),
                onDelegationStart: ({ agentId, agentName, prompt }) =>
                  logger.info(`[Auto] invoke ${agentName} (${agentId}): ${truncateForLog(prompt)}`),
                onDelegationResult: (summary) =>
                  logger.info(`[Auto] done ${summary.agentName} (${summary.agentId}): ${truncateForLog(summary.prompt)}`),
              },
            });
            const withTools = await resolveToolInvocations(result, {
              onInvoke: (tool, payload) => logger.info(`[Tool] ${tool}: ${truncateForLog(payload)}`),
              onResult: (summary) =>
                logger.info(
                  `[Tool] ${summary.tool} ${summary.ok ? "ok" : "fail"}: ${truncateForLog(summary.outputPreview)}`,
                ),
            });
            ws.send(JSON.stringify({ type: "result", ok: true, output: withTools.response }));
            if (sessionLogger) {
              sessionLogger.attachThreadId(orchestrator.getThreadId() ?? undefined);
              sessionLogger.logOutput(
                typeof withTools.response === "string"
                  ? withTools.response
                  : String(withTools.response ?? ""),
              );
            }
            historyStore.add(historyKey, {
              role: "ai",
              text: typeof withTools.response === "string" ? withTools.response : String(withTools.response ?? ""),
              ts: Date.now(),
            });
            const threadId = orchestrator.getThreadId();
            if (threadId) {
              sessionManager.saveThreadId(userId, threadId);
            }
            sendWorkspaceState(ws, currentCwd);
          } catch (error) {
            const message = (error as Error).message ?? String(error);
            const aborted = controller.signal.aborted;
            if (!aborted) {
              sessionLogger?.logError(message);
            }
            if (!aborted) {
              historyStore.add(historyKey, { role: "status", text: message, ts: Date.now(), kind: "error" });
            }
            ws.send(JSON.stringify({ type: "error", message: aborted ? "已中断，输出可能不完整" : message }));
          } finally {
            unsubscribe();
            interruptControllers.delete(userId);
            cleanupAttachments();
          }
          return;
        }

      if (!isCommand) {
        ws.send(JSON.stringify({ type: "error", message: "Unsupported message type" }));
        return;
      }

      const command = sanitizeInput(parsed.payload);
      if (!command) {
        ws.send(JSON.stringify({ type: "error", message: "Payload must be a command string" }));
        return;
      }
      sessionLogger?.logInput(command);
      historyStore.add(historyKey, { role: "user", text: command, ts: Date.now(), kind: "command" });

      const slash = parseSlashCommand(command);
      if (slash?.command === "pwd") {
        const output = `📁 当前工作目录: ${currentCwd}`;
        ws.send(JSON.stringify({ type: "result", ok: true, output }));
        sessionLogger?.logOutput(output);
        historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "status" });
        return;
      }

      if (slash?.command === "cd") {
        if (!slash.body) {
          ws.send(JSON.stringify({ type: "result", ok: false, output: "用法: /cd <path>" }));
          return;
        }
        const targetPath = slash.body;
        const prevCwd = currentCwd;
        const result = directoryManager.setUserCwd(userId, targetPath);
        if (!result.success) {
          const output = `❌ ${result.error}`;
          ws.send(JSON.stringify({ type: "result", ok: false, output }));
          sessionLogger?.logError(output);
          return;
        }
        currentCwd = directoryManager.getUserCwd(userId);
        workspaceCache.set(cacheKey, currentCwd);
        cwdStore.set(String(userId), currentCwd);
        persistCwdStore(cwdStorePath, cwdStore);
        sessionManager.setUserCwd(userId, currentCwd);
        try {
          syncWorkspaceTemplates();
        } catch (error) {
          logger.warn(`[Web] Failed to sync templates after cd: ${(error as Error).message}`);
        }
        orchestrator = sessionManager.getOrCreate(userId, currentCwd);

        const initStatus = checkWorkspaceInit(currentCwd);
        let message = `✅ 已切换到: ${currentCwd}`;
        if (prevCwd !== currentCwd) {
          message += "\n💡 代理上下文已切换到新目录";
        } else {
          message += "\nℹ️ 已在相同目录，无需重置会话";
        }
        if (!initStatus.initialized) {
          const missing = initStatus.missingArtifact ?? "ADS 必需文件";
          message += `\n⚠️ 检测到该目录尚未初始化 ADS（缺少 ${missing}）。\n如需初始化请运行 /ads.init`;
          logger.warn(
            `[Web][WorkspaceInit] path=${currentCwd} missing=${missing}${initStatus.details ? ` details=${initStatus.details}` : ""
            }`,
          );
        }
        ws.send(JSON.stringify({ type: "result", ok: true, output: message }));
        sessionLogger?.logOutput(message);
        sendWorkspaceState(ws, currentCwd);
        return;
      }

      if (slash?.command === "agent") {
        orchestrator = sessionManager.getOrCreate(userId, currentCwd);
        let agentArg = slash.body.trim();
        if (!agentArg) {
          const agents = orchestrator.listAgents();
          if (agents.length === 0) {
            const output = "❌ 暂无可用代理";
            ws.send(JSON.stringify({ type: "result", ok: false, output }));
            sessionLogger?.logOutput(output);
            return;
          }
          const activeId = orchestrator.getActiveAgentId();
          const lines = agents
            .map((entry) => {
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
          ws.send(JSON.stringify({ type: "result", ok: true, output: message }));
          sessionLogger?.logOutput(message);
          return;
        }
        const normalized = agentArg.toLowerCase();
        if (normalized === "auto" || normalized === "manual") {
          agentArg = "codex";
        }
        const switchResult = sessionManager.switchAgent(userId, agentArg);
        ws.send(JSON.stringify({ type: "result", ok: switchResult.success, output: switchResult.message }));
        sessionLogger?.logOutput(switchResult.message);
        return;
      }

      let commandToExecute = command;
      if (slash?.command === "review") {
        commandToExecute = `/ads.review${slash.body ? ` ${slash.body}` : ""}`;
      }

      const controller = new AbortController();
      interruptControllers.set(userId, controller);

      let previousWorkspaceEnv: string | undefined;
      let runPromise: Promise<{ ok: boolean; output: string }> | undefined;
      try {
        previousWorkspaceEnv = process.env.AD_WORKSPACE;
        process.env.AD_WORKSPACE = currentCwd;
        runPromise = runAdsCommandLine(commandToExecute);
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
        ws.send(JSON.stringify({ type: "result", ok: result.ok, output: result.output }));
        sessionLogger?.logOutput(result.output);
        historyStore.add(historyKey, { role: result.ok ? "ai" : "status", text: result.output, ts: Date.now(), kind: result.ok ? undefined : "command" });
        sendWorkspaceState(ws, currentCwd);
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = (error as Error).message ?? String(error);
        if (aborted) {
          // runPromise may still settle; swallow to avoid unhandled rejection
          if (runPromise) {
            void runPromise.catch((innerError) => {
              const detail = innerError instanceof Error ? innerError.message : String(innerError);
              logger.debug(`[Web] runAdsCommandLine settled after abort: ${detail}`);
            });
          }
          ws.send(JSON.stringify({ type: "error", message: "已中断，输出可能不完整" }));
          sessionLogger?.logError("已中断，输出可能不完整");
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message,
            }),
          );
          sessionLogger?.logError(message);
        }
      } finally {
        if (previousWorkspaceEnv === undefined) {
          delete process.env.AD_WORKSPACE;
        } else {
          process.env.AD_WORKSPACE = previousWorkspaceEnv;
        }
        interruptControllers.delete(userId);
      }
    });

    ws.on("close", () => log("client disconnected"));
    ws.on("close", () => clients.delete(ws));
  });

  server.listen(PORT, HOST, () => {
    log(`WebSocket server listening on ws://${HOST}:${PORT}`);
    log(`Workspace: ${workspaceRoot}`);
  });
}

start().catch((error) => {
  logger.error("[web] fatal error", error);
  process.exit(1);
});

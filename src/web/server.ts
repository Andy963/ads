import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";
import { z } from "zod";
import type {
  CommandExecutionItem,
  Input,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ThreadEvent,
  TodoListItem,
} from "@openai/codex-sdk";

import "../utils/logSink.js";
import "../utils/env.js";
import { runAdsCommandLine } from "./commandRouter.js";
import { detectWorkspace, detectWorkspaceFrom } from "../workspace/detector.js";
import { DirectoryManager } from "../telegram/utils/directoryManager.js";
import { checkWorkspaceInit } from "../telegram/utils/workspaceInitChecker.js";
import { createLogger } from "../utils/logger.js";
import type { AgentEvent } from "../codex/events.js";
import { parseSlashCommand } from "../codexConfig.js";
import { SessionManager } from "../telegram/utils/sessionManager.js";
import { ThreadStorage } from "../telegram/utils/threadStorage.js";
import { runCollaborativeTurn } from "../agents/hub.js";
import type { ExploredEntry } from "../utils/activityTracker.js";
import { syncWorkspaceTemplates } from "../workspace/service.js";
import { HistoryStore } from "../utils/historyStore.js";
import { SearchTool } from "../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../tools/search/config.js";
import { formatSearchResults } from "../tools/search/format.js";
import { formatLocalSearchOutput, searchWorkspaceFiles } from "../utils/localSearch.js";
import { stripLeadingTranslation } from "../utils/assistantText.js";
import { extractTextFromInput } from "../utils/inputText.js";
import { processAdrBlocks } from "../utils/adrRecording.js";
import { runVectorSearch } from "../vectorSearch/run.js";

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
// <= 0 disables WebSocket ping keepalive.
const pingIntervalMsRaw = Number(process.env.ADS_WEB_WS_PING_INTERVAL_MS ?? 15_000);
const WS_PING_INTERVAL_MS = Number.isFinite(pingIntervalMsRaw) ? Math.max(0, pingIntervalMsRaw) : 15_000;
// <= 0 disables web idle auto-lock / websocket close.
const idleMinutesRaw = Number(process.env.ADS_WEB_IDLE_MINUTES ?? 0);
const IDLE_MINUTES = Number.isFinite(idleMinutesRaw) ? Math.max(0, idleMinutesRaw) : 0;
const logger = createLogger("WebSocket");
const WS_READY_OPEN = 1;

// Cache last workspace per client token to persist cwd across reconnects (process memory only)
const workspaceCache = new Map<string, string>();
const interruptControllers = new Map<number, AbortController>();
const webThreadStorage = new ThreadStorage({
  namespace: "web",
  storagePath: path.join(process.cwd(), ".ads", "web-threads.json"),
});
// Disable in-memory session timeout cleanup for Web (keep sessions until process exit / explicit reset).
const sessionManager = new SessionManager(0, 0, "workspace-write", undefined, webThreadStorage);
const historyStore = new HistoryStore({
  storagePath: path.join(process.cwd(), ".ads", "state.db"),
  namespace: "web",
  migrateFromPaths: [path.join(process.cwd(), ".ads", "web-history.json")],
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = path.join(process.cwd(), ".ads", "state.db");
const cwdStore = loadCwdStore(cwdStorePath);

const wsMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
});

function log(...args: unknown[]): void {
  logger.info(args.map((a) => String(a)).join(" "));
}

function safeJsonSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WS_READY_OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[WebSocket] Failed to send message: ${message}`);
  }
}

function formatCloseReason(reason: unknown): string {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason.trim();
  }
  if (Buffer.isBuffer(reason)) {
    return reason.toString("utf8").trim();
  }
  if (Array.isArray(reason)) {
    try {
      const chunks = reason.filter((entry) => Buffer.isBuffer(entry)) as Buffer[];
      if (chunks.length === 0) {
        return "";
      }
      return Buffer.concat(chunks).toString("utf8").trim();
    } catch {
      return "";
    }
  }
  if (reason instanceof ArrayBuffer) {
    try {
      return Buffer.from(reason).toString("utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

type TodoListThreadEvent = (ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent) & {
  item: TodoListItem;
};

type AliveWebSocket = WebSocket & { isAlive?: boolean; missedPongs?: number };

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
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
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
    safeJsonSend(ws, { type: "workspace", data: state });
  } catch {
    // ignore send errors
  }
}

function renderLandingPage(): string {
  return renderLandingPageTemplate({ idleMinutes: IDLE_MINUTES, tokenRequired: Boolean(TOKEN) });
}

function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
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

  const pingTimer =
    WS_PING_INTERVAL_MS > 0
      ? setInterval(() => {
          for (const ws of clients) {
            const candidate = ws as AliveWebSocket;
            if (candidate.readyState !== 1) {
              continue;
            }
            if (candidate.isAlive === false) {
              candidate.missedPongs = (candidate.missedPongs ?? 0) + 1;
              if (candidate.missedPongs >= 3) {
                logger.warn("[WebSocket] terminating stale client connection");
                try {
                  candidate.terminate();
                } catch {
                  // ignore
                }
                continue;
              }
            } else {
              candidate.missedPongs = 0;
            }
            candidate.isAlive = false;
            try {
              candidate.ping();
            } catch {
              // ignore
            }
          }
        }, WS_PING_INTERVAL_MS)
      : null;

  pingTimer?.unref?.();

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
        if (entry.startsWith("ads-token.")) {
          token = decodeBase64Url(entry.slice("ads-token.".length));
          continue;
        }
        if (entry.startsWith("ads-token:")) {
          token = entry.split(":").slice(1).join(":");
          continue;
        }
        if (entry === "ads-token" && i + 1 < protocols.length) {
          token = protocols[i + 1];
          continue;
        }
        if (entry.startsWith("ads-session.")) {
          session = entry.slice("ads-session.".length);
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
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.missedPongs = 0;
    ws.on("pong", () => {
      aliveWs.isAlive = true;
      aliveWs.missedPongs = 0;
    });

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
    let lastPlanItems: TodoListItem["items"] | null = null;

    log("client connected");
    safeJsonSend(ws, {
      type: "welcome",
      message: "ADS WebSocket bridge ready. Send {type:'command', payload:'/ads.status'}",
      workspace: getWorkspaceState(currentCwd),
      sessionId,
    });
    const cachedHistory = historyStore.get(historyKey);
    if (cachedHistory.length > 0) {
      const sanitizedHistory = cachedHistory.map((entry) => {
        if (entry.role !== "ai") {
          return entry;
        }
        const cleanedText = stripLeadingTranslation(entry.text);
        if (cleanedText === entry.text) {
          return entry;
        }
        return { ...entry, text: cleanedText };
      });
      // /cd is a workspace state change and can repeat on reconnect; keep only the latest one to avoid UI spam.
      const cdPattern = /^\/(?:ads\.)?cd\b/i;
      const isCdCommand = (entry: { role: string; text: string }) =>
        entry.role === "user" && cdPattern.test(String(entry.text ?? "").trim());
      let lastCdIndex = -1;
      for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
        if (isCdCommand(sanitizedHistory[i])) {
          lastCdIndex = i;
          break;
        }
      }
      const filteredHistory =
        lastCdIndex >= 0
          ? sanitizedHistory.filter((entry, idx) => !isCdCommand(entry) || idx === lastCdIndex)
          : sanitizedHistory;
      safeJsonSend(ws, { type: "history", items: filteredHistory });
    }

    ws.on("message", async (data: RawData) => {
      let parsed: z.infer<typeof wsMessageSchema>;
      try {
        const raw = JSON.parse(String(data)) as unknown;
        const result = wsMessageSchema.safeParse(raw);
        if (!result.success) {
          safeJsonSend(ws, { type: "error", message: "Invalid message payload" });
          return;
        }
        parsed = result.data;
      } catch {
        safeJsonSend(ws, { type: "error", message: "Invalid JSON message" });
        return;
      }

      if (parsed.type === "ping") {
        safeJsonSend(ws, { type: "pong", ts: Date.now() });
        return;
      }

      if (parsed.type === "pong") {
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
            safeJsonSend(ws, { type: "result", ok: false, output: "⛔ 已中断，输出可能不完整" });
          } else {
            safeJsonSend(ws, { type: "error", message: "当前没有正在执行的任务" });
          }
          return;
        }

        if (parsed.type === "clear_history") {
          historyStore.clear(historyKey);
          // 同时重置 session 和 thread，清除旧的对话上下文
          sessionManager.reset(userId);
          safeJsonSend(ws, { type: "result", ok: true, output: "已清空历史缓存并重置会话" });
          return;
        }

        if (isPrompt) {
          const imageDir = path.join(currentCwd, ".ads", "temp", "web-images");
          const promptInput = buildPromptInput(parsed.payload, imageDir);
          if (!promptInput.ok) {
            sessionLogger?.logError(promptInput.message);
            safeJsonSend(ws, { type: "error", message: promptInput.message });
            return;
          }
          const tempAttachments = promptInput.attachments || [];
          const cleanupAttachments = () => cleanupTempFiles(tempAttachments);
          // 清空本轮的计划签名，等待新的 todo_list
          lastPlanSignature = null;
          // 不重置 lastPlanItems，保留上一轮的 plan 状态以便续传
          const userLogEntry = sessionLogger ? buildUserLogEntry(promptInput.input, currentCwd) : null;
          if (sessionLogger && userLogEntry) {
            sessionLogger.logInput(userLogEntry);
          }
          if (userLogEntry) {
            historyStore.add(historyKey, { role: "user", text: userLogEntry, ts: Date.now() });
          }
          const promptText = extractTextFromInput(promptInput.input).trim();

          const promptSlash = parseSlashCommand(promptText);
          if (promptSlash?.command === "search") {
            const query = promptSlash.body.trim();
            if (!query) {
              const output = "用法: /search <query>";
              safeJsonSend(ws, { type: "result", ok: false, output });
              sessionLogger?.logError(output);
              historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
              cleanupAttachments();
              return;
            }
            const config = resolveSearchConfig();
            const missingKeys = ensureApiKeys(config);
            if (missingKeys) {
              const output = `❌ /search 未启用: ${missingKeys.message}`;
              safeJsonSend(ws, { type: "result", ok: false, output });
              sessionLogger?.logError(output);
              historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
              cleanupAttachments();
              return;
            }
            try {
              const result = await SearchTool.search({ query }, { config });
              const output = formatSearchResults(query, result);
              safeJsonSend(ws, { type: "result", ok: true, output });
              sessionLogger?.logOutput(output);
              historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "command" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const output = `❌ /search 失败: ${message}`;
              safeJsonSend(ws, { type: "result", ok: false, output });
              sessionLogger?.logError(output);
              historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
            }
            cleanupAttachments();
            return;
          }

          const inputToSend: Input = promptInput.input;
          const cleanupAfter = cleanupAttachments;
          const turnCwd = currentCwd;

          const controller = new AbortController();
          interruptControllers.set(userId, controller);
          orchestrator = sessionManager.getOrCreate(userId, turnCwd);
          const status = orchestrator.status();
          if (!status.ready) {
            sessionLogger?.logError(status.error ?? "代理未启用");
            safeJsonSend(ws, { type: "error", message: status.error ?? "代理未启用，请配置凭证" });
            interruptControllers.delete(userId);
            cleanupAfter();
            return;
          }
          orchestrator.setWorkingDirectory(turnCwd);
          const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
            sessionLogger?.logEvent(event);
            logger.debug(`[Event] phase=${event.phase} title=${event.title} detail=${event.detail?.slice(0, 50)}`);
            const raw = event.raw as ThreadEvent;
            if (isTodoListEvent(raw)) {
              const signature = buildPlanSignature(raw.item.items);
              lastPlanItems = raw.item.items;
              if (signature !== lastPlanSignature) {
                lastPlanSignature = signature;
                safeJsonSend(ws, { type: "plan", items: raw.item.items });
              }
            }
            if (event.delta) {
              // 协作回合可能触发多轮 agent_message；避免前端收到混杂的增量内容
              return;
            }
            if (event.phase === "command") {
              const commandPayload = extractCommandPayload(event);
              logger.info(`[Command Event] sending command: ${JSON.stringify({ detail: event.detail ?? event.title, command: commandPayload })}`);
              safeJsonSend(ws, {
                type: "command",
                detail: event.detail ?? event.title,
                command: commandPayload ?? undefined,
              });
              return;
            }
            if (event.phase === "error") {
              safeJsonSend(ws, { type: "error", message: event.detail ?? event.title });
            }
          });

	          let exploredHeaderSent = false;
	          const handleExploredEntry = (entry: ExploredEntry) => {
	            safeJsonSend(ws, {
	              type: "explored",
	              header: !exploredHeaderSent,
	              entry: { category: entry.category, summary: entry.summary },
	            });
	            exploredHeaderSent = true;
	          };

          try {
            const result = await runCollaborativeTurn(orchestrator, inputToSend, {
              streaming: true,
              signal: controller.signal,
              // 暂时禁用结构化输出，避免复述问题
              // outputSchema: ADS_STRUCTURED_OUTPUT_SCHEMA,
              onExploredEntry: handleExploredEntry,
              hooks: {
                onSupervisorRound: (round, directives) =>
                  logger.info(`[Auto] supervisor round=${round} directives=${directives}`),
                onDelegationStart: ({ agentId, agentName, prompt }) => {
                  logger.info(`[Auto] invoke ${agentName} (${agentId}): ${truncateForLog(prompt)}`);
                  handleExploredEntry({
                    category: "Agent",
                    summary: `${agentName}（${agentId}）在后台执行：${truncateForLog(prompt, 140)}`,
                    ts: Date.now(),
                    source: "tool_hook",
                  });
                },
                onDelegationResult: (summary) => {
                  logger.info(`[Auto] done ${summary.agentName} (${summary.agentId}): ${truncateForLog(summary.prompt)}`);
                  handleExploredEntry({
                    category: "Agent",
                    summary: `✅ ${summary.agentName} 完成：${truncateForLog(summary.prompt, 140)}`,
                    ts: Date.now(),
                    source: "tool_hook",
                  });
                },
              },
              toolHooks: {
                onInvoke: (tool, payload) => logger.info(`[Tool] ${tool}: ${truncateForLog(payload)}`),
                onResult: (summary) =>
                  logger.info(
                    `[Tool] ${summary.tool} ${summary.ok ? "ok" : "fail"}: ${truncateForLog(summary.outputPreview)}`,
                  ),
              },
              toolContext: { cwd: turnCwd, allowedDirs, historyNamespace: "web", historySessionId: historyKey },
            });

            const rawResponse =
              typeof result.response === "string" ? result.response : String(result.response ?? "");
            const finalOutput = stripLeadingTranslation(rawResponse);
            const workspaceRootForAdr = detectWorkspaceFrom(turnCwd);
            let outputToSend = finalOutput;
            try {
              const adrProcessed = processAdrBlocks(finalOutput, workspaceRootForAdr);
              outputToSend = adrProcessed.finalText || finalOutput;
	            } catch (error) {
	              const message = error instanceof Error ? error.message : String(error);
	              outputToSend = `${finalOutput}\n\n---\nADR warning: failed to record ADR (${message})`;
	            }
	            if (lastPlanItems) {
	              safeJsonSend(ws, { type: "plan", items: lastPlanItems });
	            }
	            safeJsonSend(ws, { type: "result", ok: true, output: outputToSend });
	            if (sessionLogger) {
	              sessionLogger.attachThreadId(orchestrator.getThreadId() ?? undefined);
	              sessionLogger.logOutput(outputToSend);
	            }
            historyStore.add(historyKey, {
              role: "ai",
              text: outputToSend,
              ts: Date.now(),
            });
            const threadId = orchestrator.getThreadId();
            if (threadId) {
              sessionManager.saveThreadId(userId, threadId, orchestrator.getActiveAgentId());
            }
            sendWorkspaceState(ws, turnCwd);
          } catch (error) {
            const message = (error as Error).message ?? String(error);
            const aborted = controller.signal.aborted;
            if (!aborted) {
              sessionLogger?.logError(message);
            }
	            if (!aborted) {
	              historyStore.add(historyKey, { role: "status", text: message, ts: Date.now(), kind: "error" });
	            }
	            safeJsonSend(ws, { type: "error", message: aborted ? "已中断，输出可能不完整" : message });
	          } finally {
	            unsubscribe();
	            interruptControllers.delete(userId);
	            cleanupAfter();
	          }
          return;
        }

	      if (!isCommand) {
	        safeJsonSend(ws, { type: "error", message: "Unsupported message type" });
	        return;
	      }

	      const commandRaw = sanitizeInput(parsed.payload);
	      if (!commandRaw) {
	        safeJsonSend(ws, { type: "error", message: "Payload must be a command string" });
	        return;
	      }
	      const command = commandRaw.trim();
      const isSilentCommandPayload =
        parsed.payload !== null &&
        typeof parsed.payload === "object" &&
        !Array.isArray(parsed.payload) &&
        (parsed.payload as Record<string, unknown>).silent === true;

	      const slash = parseSlashCommand(command);
	      const normalizedSlash = slash?.command?.toLowerCase();
	      const isCdCommand = normalizedSlash === "cd" || normalizedSlash === "ads.cd";
      if (!isSilentCommandPayload && !isCdCommand) {
        sessionLogger?.logInput(command);
        historyStore.add(historyKey, { role: "user", text: command, ts: Date.now(), kind: "command" });
      }

	      if (slash?.command === "vsearch") {
	        const query = slash.body.trim();
	        const workspaceRoot = detectWorkspaceFrom(currentCwd);
	        const output = await runVectorSearch({ workspaceRoot, query, entryNamespace: "web" });
	        const note =
	          "ℹ️ 提示：系统会在后台自动用向量召回来补齐 agent 上下文；/vsearch 主要用于手动调试/查看原始召回结果。";
	        const decorated = output.startsWith("Vector search results for:") ? `${note}\n\n${output}` : output;
	        safeJsonSend(ws, { type: "result", ok: true, output: decorated });
	        sessionLogger?.logOutput(decorated);
	        historyStore.add(historyKey, { role: "status", text: decorated, ts: Date.now(), kind: "command" });
	        return;
	      }
	      if (slash?.command === "search") {
	        const query = slash.body.trim();
	        if (!query) {
	          const output = "用法: /search <query>";
	          safeJsonSend(ws, { type: "result", ok: false, output });
	          sessionLogger?.logError(output);
	          historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
	          return;
	        }
        const config = resolveSearchConfig();
	        const missingKeys = ensureApiKeys(config);
	        if (missingKeys) {
	          const workspaceRoot = detectWorkspaceFrom(currentCwd);
	          const local = searchWorkspaceFiles({ workspaceRoot, query });
	          const output = formatLocalSearchOutput({ query, ...local });
	          safeJsonSend(ws, { type: "result", ok: true, output });
	          sessionLogger?.logOutput(output);
	          historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "command" });
	          return;
	        }
	        try {
	          const result = await SearchTool.search({ query }, { config });
	          const output = formatSearchResults(query, result);
	          safeJsonSend(ws, { type: "result", ok: true, output });
	          sessionLogger?.logOutput(output);
          historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "command" });
	        } catch (error) {
	          const message = error instanceof Error ? error.message : String(error);
	          const output = `❌ /search 失败: ${message}`;
	          safeJsonSend(ws, { type: "result", ok: false, output });
	          sessionLogger?.logError(output);
	          historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
	        }
	        return;
	      }
	      if (slash?.command === "pwd") {
	        const output = `📁 当前工作目录: ${currentCwd}`;
	        safeJsonSend(ws, { type: "result", ok: true, output });
	        sessionLogger?.logOutput(output);
	        historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "status" });
	        return;
	      }

	      if (slash?.command === "cd") {
	        if (!slash.body) {
	          safeJsonSend(ws, { type: "result", ok: false, output: "用法: /cd <path>" });
	          return;
	        }
        const targetPath = slash.body;
        const prevCwd = currentCwd;
	        const result = directoryManager.setUserCwd(userId, targetPath);
	        if (!result.success) {
	          const output = `❌ ${result.error}`;
	          safeJsonSend(ws, { type: "result", ok: false, output });
	          sessionLogger?.logError(output);
	          return;
	        }
        currentCwd = directoryManager.getUserCwd(userId);
        if (prevCwd !== currentCwd) {
          // Workspace switch should clear any in-flight plan so the UI doesn't show stale tasks.
	          lastPlanSignature = null;
	          lastPlanItems = null;
	          safeJsonSend(ws, { type: "plan", items: [] });
	        }
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
	        if (!isSilentCommandPayload) {
	          safeJsonSend(ws, { type: "result", ok: true, output: message });
	          sessionLogger?.logOutput(message);
	        }
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
	            safeJsonSend(ws, { type: "result", ok: false, output });
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
	          safeJsonSend(ws, { type: "result", ok: true, output: message });
	          sessionLogger?.logOutput(message);
	          return;
	        }
        const normalized = agentArg.toLowerCase();
        if (normalized === "auto" || normalized === "manual") {
          agentArg = "codex";
        }
        const switchResult = sessionManager.switchAgent(userId, agentArg);
        safeJsonSend(ws, { type: "result", ok: switchResult.success, output: switchResult.message });
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
        safeJsonSend(ws, { type: "result", ok: result.ok, output: result.output });
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
          safeJsonSend(ws, { type: "error", message: "已中断，输出可能不完整" });
          sessionLogger?.logError("已中断，输出可能不完整");
        } else {
          safeJsonSend(ws, { type: "error", message });
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

    ws.on("close", (code, reason) => {
      clients.delete(ws);
      const reasonText = formatCloseReason(reason);
      const suffix = reasonText ? ` reason=${reasonText}` : "";
      log(`client disconnected session=${sessionId} user=${userId} code=${code}${suffix}`);
    });
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

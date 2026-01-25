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
import { resolveAdsStateDir, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";
import { DirectoryManager } from "../telegram/utils/directoryManager.js";
import { createLogger } from "../utils/logger.js";
import type { AgentEvent } from "../codex/events.js";
import type { AgentIdentifier } from "../agents/types.js";
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

import { TaskQueue } from "../tasks/queue.js";
import { TaskStore as QueueTaskStore } from "../tasks/store.js";
import { OrchestratorTaskPlanner } from "../tasks/planner.js";
import { OrchestratorTaskExecutor } from "../tasks/executor.js";
import type { TaskStatus as QueueTaskStatus } from "../tasks/types.js";
import { AsyncLock } from "../utils/asyncLock.js";

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
// SECURITY: Do NOT change this default. Keep the Web server loopback-only by default.
// If you need remote access, use a reverse proxy and/or set ADS_WEB_HOST explicitly.
const HOST = process.env.ADS_WEB_HOST || "127.0.0.1";
const TOKEN = (process.env.ADS_WEB_TOKEN ?? process.env.WEB_AUTH_TOKEN ?? "").trim();
const MAX_CLIENTS = Math.max(1, Number(process.env.ADS_WEB_MAX_CLIENTS ?? 1));
// <= 0 disables WebSocket ping keepalive.
const pingIntervalMsRaw = Number(process.env.ADS_WEB_WS_PING_INTERVAL_MS ?? 15_000);
const WS_PING_INTERVAL_MS = Number.isFinite(pingIntervalMsRaw) ? Math.max(0, pingIntervalMsRaw) : 15_000;
const logger = createLogger("WebSocket");
const WS_READY_OPEN = 1;

// Cache last workspace per client token to persist cwd across reconnects (process memory only)
const workspaceCache = new Map<string, string>();
const interruptControllers = new Map<number, AbortController>();
const adsStateDir = resolveAdsStateDir();
const webThreadStorage = new ThreadStorage({
  namespace: "web",
  storagePath: path.join(adsStateDir, "web-threads.json"),
});
// Disable in-memory session timeout cleanup for Web (keep sessions until process exit / explicit reset).
const sessionManager = new SessionManager(0, 0, "workspace-write", undefined, webThreadStorage);
const historyStore = new HistoryStore({
  storagePath: path.join(adsStateDir, "state.db"),
  namespace: "web",
  migrateFromPaths: [path.join(adsStateDir, "web-history.json")],
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = path.join(adsStateDir, "state.db");
const cwdStore = loadCwdStore(cwdStorePath);

const wsMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
});

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseTaskStatus(value: string | undefined | null): QueueTaskStatus | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "pending":
    case "planning":
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return undefined;
  }
}

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function deriveProjectSessionId(projectRoot: string): string {
  const digest = crypto.createHash("sha256").update(projectRoot).digest();
  return toBase64Url(digest);
}

function selectAgentForModel(model: string): AgentIdentifier {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (normalized.startsWith("gemini")) {
    return "gemini";
  }
  return "codex";
}

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
  void workspaceRoot;
  const runDir = path.join(adsStateDir, "run");
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

function extractBearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() ?? null;
}

function extractQueryToken(req: http.IncomingMessage): string | null {
  const url = req.url;
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url, "http://localhost");
    const token = parsed.searchParams.get("token");
    return token ? token.trim() : null;
  } catch {
    return null;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  const raw = String(address ?? "").trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === "127.0.0.1" || raw === "::1") {
    return true;
  }
  if (raw.startsWith("::ffff:")) {
    return raw.slice("::ffff:".length) === "127.0.0.1";
  }
  return false;
}

function isRequestAuthorized(req: http.IncomingMessage): boolean {
  if (!TOKEN) {
    return isLoopbackAddress(req.socket.remoteAddress);
  }
  const token = extractBearerToken(req) ?? extractQueryToken(req);
  return token === TOKEN;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1_000_000) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

async function readRawBody(req: http.IncomingMessage, options?: { maxBytes?: number }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = Math.max(1, options?.maxBytes ?? 25 * 1024 * 1024);
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function createHttpServer(options: { handleApiRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> }): http.Server {
  const distWebDir = path.join(process.cwd(), "dist", "web");


  const contentTypeFor = (filePath: string): string => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".html":
        return "text/html; charset=utf-8";
      case ".js":
        return "text/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".ico":
        return "image/x-icon";
      case ".woff2":
        return "font/woff2";
      case ".map":
        return "application/json; charset=utf-8";
      default:
        return "application/octet-stream";
    }
  };

  const serveFile = (res: http.ServerResponse, filePath: string): boolean => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return false;
      }
      res.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(filePath).pipe(res);
      return true;
    } catch {
      return false;
    }
  };

  const serveTasksUi = (res: http.ServerResponse, url: string): boolean => {
    if (!fs.existsSync(distWebDir)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Web app not built. Run: npm run build:web\n");
      return true;
    }

    const raw = (url.split("?")[0] ?? "/").trim();
    const rel = raw.startsWith("/") ? raw : `/${raw}`;
    const normalized = path.posix.normalize(rel);
    const safeRel = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const resolved = path.resolve(distWebDir, "." + safeRel);
    if (!resolved.startsWith(distWebDir)) {
      res.writeHead(403).end("Forbidden");
      return true;
    }

    if (safeRel === "/" || safeRel === "") {
      return serveFile(res, path.join(distWebDir, "index.html"));
    }

    if (serveFile(res, resolved)) {
      return true;
    }

    // SPA fallback: any path without file extension -> index.html
    if (!path.posix.basename(safeRel).includes(".")) {
      return serveFile(res, path.join(distWebDir, "index.html"));
    }

    res.writeHead(404).end("Not Found");
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (!TOKEN && !isLoopbackAddress(req.socket.remoteAddress) && !url.startsWith("/healthz")) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    if (url.startsWith("/api/")) {
      if (!isRequestAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const handler = options.handleApiRequest;
      if (!handler) {
        sendJson(res, 404, { error: "Not Found" });
        return;
      }
      void handler(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          sendJson(res, 500, { error: message });
        } else {
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      });
      return;
    }

    if (req.method === "GET") {
      if (url.startsWith("/healthz")) {
        res.writeHead(200).end("ok");
        return;
      }
      serveTasksUi(res, url);
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
  const workspaceRoot = detectWorkspace();
  const allowedDirs = resolveAllowedDirs(workspaceRoot);

  const taskStore = new QueueTaskStore({ workspacePath: workspaceRoot });
  const taskQueueStatusUserId = 0;
  const taskQueueThreadStorage = new ThreadStorage({
    namespace: "task-queue",
    storagePath: path.join(adsStateDir, "task-queue-threads.json"),
  });
  const taskQueueSessionManager = new SessionManager(0, 0, "workspace-write", process.env.TASK_QUEUE_DEFAULT_MODEL, taskQueueThreadStorage);
  const getStatusOrchestrator = () => taskQueueSessionManager.getOrCreate(taskQueueStatusUserId, workspaceRoot, true);
  const taskQueueLock = new AsyncLock();

  const hashTaskId = (taskId: string): number => {
    const normalized = String(taskId ?? "").trim();
    if (!normalized) return 0;
    const compact = normalized.replace(/-/g, "");
    const hex = compact.slice(0, 8);
    const parsed = Number.parseInt(hex, 16);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    // FNV-1a 32-bit
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };

  const getTaskQueueOrchestrator = (task: { id: string }) => {
    const userId = hashTaskId(task.id);
    return taskQueueSessionManager.getOrCreate(userId, workspaceRoot, true);
  };

  const planner = new OrchestratorTaskPlanner({
    getOrchestrator: getTaskQueueOrchestrator,
    planModel: process.env.TASK_QUEUE_PLAN_MODEL ?? "gpt-5",
    lock: taskQueueLock,
  });
  const executor = new OrchestratorTaskExecutor({
    getOrchestrator: getTaskQueueOrchestrator,
    store: taskStore,
    defaultModel: process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2",
    lock: taskQueueLock,
  });
  const taskQueue = new TaskQueue({ store: taskStore, planner, executor });
  const shouldRunTaskQueue = parseBooleanFlag(process.env.TASK_QUEUE_ENABLED, true);

  let broadcast: (payload: unknown) => void = () => {};
  const clientHistoryKeyByWs = new Map<WebSocket, string>();
  const recordToAllClientHistories = (entry: { role: string; text: string; ts: number; kind?: string }): void => {
    for (const historyKey of clientHistoryKeyByWs.values()) {
      try {
        historyStore.add(historyKey, entry);
      } catch {
        // ignore
      }
    }
  };

  const server = createHttpServer({
    handleApiRequest: async (req, res) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "POST" && pathname === "/api/audio/transcriptions") {
        const preferProviderRaw = String(process.env.ADS_AUDIO_TRANSCRIPTION_PROVIDER ?? "together")
          .trim()
          .toLowerCase();
        const preferProvider = preferProviderRaw === "openai" ? "openai" : "together";
        const togetherKey = String(process.env.TOGETHER_API_KEY ?? "").trim();
        const openaiKey = String(
          process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY ?? process.env.CCHAT_OPENAI_API_KEY ?? "",
        ).trim();
        const openaiBaseUrl = String(
          process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE ?? process.env.CODEX_BASE_URL ?? "https://api.openai.com/v1",
        ).trim();

        let contentType = String(req.headers["content-type"] ?? "").trim();
        if (contentType.includes(";")) {
          contentType = contentType.split(";")[0]!.trim();
        }
        if (!contentType) {
          contentType = "application/octet-stream";
        }

        let audio: Buffer;
        try {
          audio = await readRawBody(req, { maxBytes: 25 * 1024 * 1024 });
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const message = rawMessage === "Request body too large" ? "音频过大（>25MB）" : rawMessage;
          sendJson(res, 413, { error: message });
          return true;
        }
        if (!audio || audio.length === 0) {
          sendJson(res, 400, { error: "音频为空" });
          return true;
        }

	        const ext = (() => {
	          const t = contentType.toLowerCase();
	          if (t.includes("webm")) return "webm";
	          if (t.includes("ogg")) return "ogg";
	          if (t.includes("wav")) return "wav";
	          if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
	          if (t.includes("mp4") || t.includes("m4a")) return "m4a";
	          return "bin";
	        })();

        const audioArrayBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;

        const createForm = (model: string): FormData => {
          const form = new FormData();
          form.append("model", model);
          form.append("file", new Blob([audioArrayBuffer], { type: contentType }), `recording.${ext}`);
          return form;
        };

        const parseJsonText = (raw: string): unknown => {
          try {
            return raw ? (JSON.parse(raw) as unknown) : null;
          } catch {
            return null;
          }
        };

        const extractErrorMessage = (parsed: unknown, raw: string, status: number): string => {
          const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          const nestedError = record?.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null;
          return (
            String(nestedError?.message ?? record?.message ?? record?.error ?? raw ?? "").trim() ||
            `上游服务错误（${status}）`
          );
        };

        const extractText = (parsed: unknown): string => {
          const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
          return (
            (typeof record?.text === "string" ? record.text : "") ||
            (typeof record?.transcript === "string" ? record.transcript : "") ||
            (typeof record?.transcription === "string" ? record.transcription : "")
          );
        };

        const controller = new AbortController();
        const timeoutMsRaw = Number(process.env.ADS_TOGETHER_AUDIO_TIMEOUT_MS ?? 60_000);
        const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, timeoutMsRaw) : 60_000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const callTogether = async (): Promise<string> => {
            if (!togetherKey) {
              throw new Error("未配置 TOGETHER_API_KEY");
            }
            const upstream = await fetch("https://api.together.xyz/v1/audio/transcriptions", {
              method: "POST",
              headers: { Authorization: `Bearer ${togetherKey}` },
              body: createForm("openai/whisper-large-v3"),
              signal: controller.signal,
            });
            const raw = await upstream.text().catch(() => "");
            const parsed = parseJsonText(raw);
            if (!upstream.ok) {
              throw new Error(extractErrorMessage(parsed, raw, upstream.status));
            }
            return extractText(parsed);
          };

          const callOpenAI = async (): Promise<string> => {
            if (!openaiKey) {
              throw new Error("未配置 OPENAI_API_KEY");
            }
            const base = (openaiBaseUrl ? openaiBaseUrl : "https://api.openai.com/v1").replace(/\/+$/g, "");
            const upstream = await fetch(`${base}/audio/transcriptions`, {
              method: "POST",
              headers: { Authorization: `Bearer ${openaiKey}` },
              body: createForm("whisper-1"),
              signal: controller.signal,
            });
            const raw = await upstream.text().catch(() => "");
            const parsed = parseJsonText(raw);
            if (!upstream.ok) {
              throw new Error(extractErrorMessage(parsed, raw, upstream.status));
            }
            return extractText(parsed);
          };

          const attempts =
            preferProvider === "openai"
              ? [
                  { name: "openai", fn: callOpenAI },
                  { name: "together", fn: callTogether },
                ]
              : [
                  { name: "together", fn: callTogether },
                  { name: "openai", fn: callOpenAI },
                ];

          const errors: string[] = [];
          for (const attempt of attempts) {
            try {
              const text = (await attempt.fn()).trim();
              if (!text) {
                throw new Error("未识别到文本");
              }
              sendJson(res, 200, { ok: true, text });
              return true;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(`${attempt.name}: ${message || "unknown error"}`);
              logger.warn(`[Audio] transcription via ${attempt.name} failed: ${message}`);
            }
          }

          sendJson(res, 502, { error: errors[0] ?? "语音识别失败" });
          return true;
        } catch (error) {
          const aborted = controller.signal.aborted;
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, aborted ? 504 : 502, { error: aborted ? "语音识别超时" : message });
          return true;
        } finally {
          clearTimeout(timeout);
        }
      }

      if (req.method === "GET" && pathname === "/api/paths/validate") {
        const candidate = url.searchParams.get("path")?.trim() ?? "";
        const directoryManager = new DirectoryManager(allowedDirs);
        if (!candidate) {
          sendJson(res, 200, {
            ok: false,
            allowed: false,
            exists: false,
            isDirectory: false,
            error: "缺少 path 参数",
          });
          return true;
        }

        const absolutePath = path.resolve(candidate);
        if (!directoryManager.validatePath(absolutePath)) {
          sendJson(res, 200, {
            ok: false,
            allowed: false,
            exists: false,
            isDirectory: false,
            error: "目录不在白名单内",
            allowedDirs,
          });
          return true;
        }

        if (!fs.existsSync(absolutePath)) {
          sendJson(res, 200, {
            ok: false,
            allowed: true,
            exists: false,
            isDirectory: false,
            resolvedPath: absolutePath,
            error: "目录不存在",
          });
          return true;
        }

        let resolvedPath = absolutePath;
        try {
          resolvedPath = fs.realpathSync(absolutePath);
        } catch {
          resolvedPath = absolutePath;
        }

        let isDirectory = false;
        try {
          isDirectory = fs.statSync(resolvedPath).isDirectory();
        } catch {
          isDirectory = false;
        }

        if (!isDirectory) {
          sendJson(res, 200, {
            ok: false,
            allowed: true,
            exists: true,
            isDirectory: false,
            resolvedPath,
            error: "路径存在但不是目录",
          });
          return true;
        }

        const workspaceRootCandidate = detectWorkspaceFrom(resolvedPath);
        let workspaceRoot = workspaceRootCandidate;
        try {
          workspaceRoot = fs.realpathSync(workspaceRootCandidate);
        } catch {
          workspaceRoot = workspaceRootCandidate;
        }
        if (!directoryManager.validatePath(workspaceRoot)) {
          workspaceRoot = resolvedPath;
        }

        sendJson(res, 200, {
          ok: true,
          allowed: true,
          exists: true,
          isDirectory: true,
          resolvedPath,
          workspaceRoot,
          projectSessionId: deriveProjectSessionId(workspaceRoot),
        });
        return true;
      }

      if (req.method === "GET" && pathname === "/api/models") {
        const allowedModels = ["gpt-5.1", "gpt-5.2"];
        const models = taskStore.listModelConfigs().filter((m) => allowedModels.includes(m.id));
        sendJson(res, 200, models);
        return true;
      }

      if (req.method === "GET" && pathname === "/api/task-queue/status") {
        const status = getStatusOrchestrator().status();
        sendJson(res, 200, { enabled: shouldRunTaskQueue, ...status });
        return true;
      }

      if (req.method === "GET" && pathname === "/api/tasks") {
        const status = parseTaskStatus(url.searchParams.get("status"));
        const limitRaw = url.searchParams.get("limit")?.trim();
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
        sendJson(res, 200, taskStore.listTasks({ status, limit }));
        return true;
      }

      if (req.method === "POST" && pathname === "/api/tasks") {
        const body = await readJsonBody(req);
        const schema = z
          .object({
            title: z.string().min(1).optional(),
            prompt: z.string().min(1),
            model: z.string().optional(),
            priority: z.number().optional(),
            inheritContext: z.boolean().optional(),
            maxRetries: z.number().optional(),
          })
          .passthrough();
        const parsed = schema.parse(body ?? {});
        const task = taskStore.createTask({
          title: parsed.title,
          prompt: parsed.prompt,
          model: parsed.model,
          priority: parsed.priority,
          inheritContext: parsed.inheritContext,
          maxRetries: parsed.maxRetries,
          createdBy: "web",
        });
        taskQueue.notifyNewTask();
        try {
          if (task.prompt && task.prompt.trim()) {
            recordToAllClientHistories({ role: "user", text: task.prompt.trim(), ts: Date.now() });
          }
        } catch {
          // ignore
        }
        broadcast({ type: "task:event", event: "task:updated", data: task, ts: Date.now() });
        sendJson(res, 200, task);
        return true;
      }

      const retryMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);
      if (retryMatch && req.method === "POST") {
        const taskId = retryMatch[1] ?? "";
        taskQueue.retry(taskId);
        const task = taskStore.getTask(taskId);
        if (task) {
          broadcast({ type: "task:event", event: "task:updated", data: task, ts: Date.now() });
        }
        sendJson(res, 200, { success: true, task });
        return true;
      }

      const chatMatch = /^\/api\/tasks\/([^/]+)\/chat$/.exec(pathname);
      if (chatMatch && req.method === "POST") {
        if (!shouldRunTaskQueue) {
          sendJson(res, 409, { error: "Task queue disabled" });
          return true;
        }
        const taskId = chatMatch[1] ?? "";
        const task = taskStore.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: "Not Found" });
          return true;
        }
        if (task.status === "cancelled") {
          sendJson(res, 409, { error: "Task is cancelled" });
          return true;
        }

        const body = await readJsonBody(req);
        const schema = z.object({ content: z.string().min(1) }).passthrough();
        const parsed = schema.parse(body ?? {});
        const content = String(parsed.content ?? "").trim();
        if (!content) {
          sendJson(res, 400, { error: "Empty message" });
          return true;
        }

        try {
          taskStore.addMessage({
            taskId: task.id,
            planStepId: null,
            role: "user",
            content,
            messageType: "chat",
            modelUsed: null,
            tokenCount: null,
            createdAt: Date.now(),
          });
        } catch {
          // ignore
        }
        broadcast({ type: "task:event", event: "message", data: { taskId: task.id, role: "user", content }, ts: Date.now() });

        void taskQueueLock.runExclusive(async () => {
          const latest = taskStore.getTask(taskId);
          if (!latest || latest.status === "cancelled") {
            return;
          }
          const desiredModel = String(latest.model ?? "").trim() || "auto";
          const modelToUse = desiredModel === "auto" ? (process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2") : desiredModel;
          const orchestrator = getTaskQueueOrchestrator(latest);
          orchestrator.setModel(modelToUse);
          const agentId = selectAgentForModel(modelToUse);

          let lastRespondingText = "";
          const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
            try {
              if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
                const next = event.delta;
                let delta = next;
                if (lastRespondingText && next.startsWith(lastRespondingText)) {
                  delta = next.slice(lastRespondingText.length);
                }
                if (next.length >= lastRespondingText.length) {
                  lastRespondingText = next;
                }
                if (delta) {
                  broadcast({
                    type: "task:event",
                    event: "message:delta",
                    data: { taskId: latest.id, role: "assistant", delta, modelUsed: modelToUse, source: "chat" },
                    ts: Date.now(),
                  });
                }
                return;
              }
              if (event.phase === "command" && event.title === "执行命令" && event.detail) {
                const command = String(event.detail).split(" | ")[0]?.trim();
                if (command) {
                  try {
                    taskStore.addMessage({
                      taskId: latest.id,
                      planStepId: null,
                      role: "system",
                      content: `$ ${command}`,
                      messageType: "command",
                      modelUsed: null,
                      tokenCount: null,
                      createdAt: Date.now(),
                    });
                  } catch {
                    // ignore
                  }
                  broadcast({ type: "task:event", event: "command", data: { taskId: latest.id, command }, ts: Date.now() });
                }
              }
            } catch {
              // ignore
            }
          });

          try {
            const prompt = [
              "你是一个正在执行任务的开发助手。",
              `任务标题: ${latest.title}`,
              `任务描述: ${latest.prompt}`,
              "",
              "用户追加指令：",
              content,
            ].join("\n");

            const result = await orchestrator.invokeAgent(agentId, prompt, { streaming: true });
            const text = typeof result.response === "string" ? result.response : String(result.response ?? "");
            try {
              taskStore.addMessage({
                taskId: latest.id,
                planStepId: null,
                role: "assistant",
                content: text,
                messageType: "chat",
                modelUsed: modelToUse,
                tokenCount: null,
                createdAt: Date.now(),
              });
            } catch {
              // ignore
            }
            broadcast({ type: "task:event", event: "message", data: { taskId: latest.id, role: "assistant", content: text }, ts: Date.now() });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            broadcast({ type: "task:event", event: "message", data: { taskId: taskId, role: "system", content: `[交互失败] ${msg}` }, ts: Date.now() });
          } finally {
            try {
              unsubscribe();
            } catch {
              // ignore
            }
          }
        });

        sendJson(res, 200, { success: true });
        return true;
      }

      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
      if (taskMatch) {
        const taskId = taskMatch[1] ?? "";

        if (req.method === "GET") {
          const task = taskStore.getTask(taskId);
          if (!task) {
            sendJson(res, 404, { error: "Not Found" });
            return true;
          }
          sendJson(res, 200, { ...task, plan: taskStore.getPlan(taskId), messages: taskStore.getMessages(taskId) });
          return true;
        }

        if (req.method === "DELETE") {
          taskStore.deleteTask(taskId);
          sendJson(res, 200, { success: true });
          return true;
        }

        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const action = typeof (body as { action?: unknown } | null)?.action === "string" ? String((body as { action: string }).action) : "";
          if (action) {
            const schema = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).passthrough();
            const parsed = schema.parse(body ?? {});
            if (parsed.action === "pause") {
              taskQueue.pause("api");
            } else if (parsed.action === "resume") {
              taskQueue.resume();
            } else if (parsed.action === "cancel") {
              taskQueue.cancel(taskId);
              const task = taskStore.getTask(taskId);
              if (task) {
                broadcast({ type: "task:event", event: "task:cancelled", data: task, ts: Date.now() });
              }
              sendJson(res, 200, { success: true, task });
              return true;
            }
            sendJson(res, 200, { success: true });
            return true;
          }

          const updateSchema = z
            .object({
              title: z.string().min(1).optional(),
              prompt: z.string().min(1).optional(),
              model: z.string().min(1).optional(),
              priority: z.number().finite().optional(),
              inheritContext: z.boolean().optional(),
              maxRetries: z.number().int().min(0).optional(),
            })
            .passthrough();
          const parsed = updateSchema.parse(body ?? {});
          const keys = Object.keys(parsed).filter((k) => ["title", "prompt", "model", "priority", "inheritContext", "maxRetries"].includes(k));
          if (keys.length === 0) {
            sendJson(res, 400, { error: "No updates provided" });
            return true;
          }

          const existing = taskStore.getTask(taskId);
          if (!existing) {
            sendJson(res, 404, { error: "Not Found" });
            return true;
          }
          if (existing.status !== "pending") {
            sendJson(res, 409, { error: `Task not editable in status: ${existing.status}` });
            return true;
          }

          const updates: Record<string, unknown> = {};
          if (parsed.title !== undefined) updates.title = parsed.title;
          if (parsed.prompt !== undefined) updates.prompt = parsed.prompt;
          if (parsed.model !== undefined) updates.model = parsed.model;
          if (parsed.priority !== undefined) updates.priority = parsed.priority;
          if (parsed.inheritContext !== undefined) updates.inheritContext = parsed.inheritContext;
          if (parsed.maxRetries !== undefined) updates.maxRetries = parsed.maxRetries;

          const updated = taskStore.updateTask(taskId, updates, Date.now());
          taskQueue.notifyNewTask();
          broadcast({ type: "task:event", event: "task:updated", data: updated, ts: Date.now() });
          sendJson(res, 200, { success: true, task: updated });
          return true;
        }
      }

      sendJson(res, 404, { error: "Not Found" });
      return true;
    },
  });
  const wss = new WebSocketServer({ server });
  try {
    syncWorkspaceTemplates();
  } catch (error) {
    logger.warn(`[Web] Failed to sync templates: ${(error as Error).message}`);
  }
  await ensureWebPidFile(workspaceRoot);
  const clients: Set<WebSocket> = new Set();

  broadcast = (payload: unknown) => {
    for (const ws of clients) {
      safeJsonSend(ws, payload);
    }
  };

  taskQueue.on("task:started", ({ task }) => broadcast({ type: "task:event", event: "task:started", data: task, ts: Date.now() }));
  taskQueue.on("task:planned", ({ task, plan }) => broadcast({ type: "task:event", event: "task:planned", data: { task, plan }, ts: Date.now() }));
  taskQueue.on("task:running", ({ task }) => broadcast({ type: "task:event", event: "task:running", data: task, ts: Date.now() }));
  taskQueue.on("step:started", ({ task, step }) => broadcast({ type: "task:event", event: "step:started", data: { taskId: task.id, step }, ts: Date.now() }));
  taskQueue.on("step:completed", ({ task, step }) => broadcast({ type: "task:event", event: "step:completed", data: { taskId: task.id, step }, ts: Date.now() }));
  taskQueue.on("message", ({ task, role, content }) => broadcast({ type: "task:event", event: "message", data: { taskId: task.id, role, content }, ts: Date.now() }));
  taskQueue.on("message:delta", ({ task, role, delta, modelUsed, source }) =>
    broadcast({ type: "task:event", event: "message:delta", data: { taskId: task.id, role, delta, modelUsed, source }, ts: Date.now() }),
  );
  taskQueue.on("command", ({ task, command }) => {
    broadcast({ type: "task:event", event: "command", data: { taskId: task.id, command }, ts: Date.now() });
    try {
      recordToAllClientHistories({ role: "status", text: `$ ${command}`, ts: Date.now(), kind: "command" });
    } catch {
      // ignore
    }
  });
  taskQueue.on("task:completed", ({ task }) => {
    broadcast({ type: "task:event", event: "task:completed", data: task, ts: Date.now() });
    try {
      if (task.result && task.result.trim()) {
        recordToAllClientHistories({ role: "ai", text: task.result.trim(), ts: Date.now() });
      }
    } catch {
      // ignore
    }
  });
  taskQueue.on("task:failed", ({ task, error }) => {
    broadcast({ type: "task:event", event: "task:failed", data: { task, error }, ts: Date.now() });
    try {
      recordToAllClientHistories({ role: "status", text: `[任务失败] ${error}`, ts: Date.now(), kind: "error" });
    } catch {
      // ignore
    }
  });
  taskQueue.on("task:cancelled", ({ task }) => {
    broadcast({ type: "task:event", event: "task:cancelled", data: task, ts: Date.now() });
    try {
      recordToAllClientHistories({ role: "status", text: "[已终止]", ts: Date.now(), kind: "status" });
    } catch {
      // ignore
    }
  });

  if (shouldRunTaskQueue) {
    const status = getStatusOrchestrator().status();
    void taskQueue.start();
    logger.info("[Web] TaskQueue started");
    if (!status.ready) {
      logger.warn(`[Web] Agent not ready yet; tasks may fail: ${status.error ?? "unknown"}`);
    }
  }

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
    if (TOKEN) {
      if (wsToken !== TOKEN) {
        ws.close(4401, "unauthorized");
        return;
      }
    } else if (!isLoopbackAddress(req.socket.remoteAddress)) {
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
    clientHistoryKeyByWs.set(ws, historyKey);
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
      const cdPattern = /^\/cd\b/i;
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
	          await taskQueueLock.runExclusive(async () => {
	          const imageDir = resolveWorkspaceStatePath(detectWorkspaceFrom(currentCwd), "temp", "web-images");
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
              const output = `/search 未启用: ${missingKeys.message}`;
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
              historyStore.add(historyKey, { role: "ai", text: output, ts: Date.now() });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const output = `/search 失败: ${message}`;
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
	          let lastRespondingText = "";
	          const lastCommandOutputs = new Map<string, string>();
	          const announcedCommandIds = new Set<string>();
	          let hasCommandOutput = false;
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
            if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
              const next = event.delta;
              let delta = next;
              if (lastRespondingText && next.startsWith(lastRespondingText)) {
                delta = next.slice(lastRespondingText.length);
              }
              if (next.length >= lastRespondingText.length) {
                lastRespondingText = next;
              }
              if (delta) {
                safeJsonSend(ws, { type: "delta", delta });
              }
              return;
	            }
	            if (event.phase === "command") {
	              const commandPayload = extractCommandPayload(event);
	              logger.info(
	                `[Command Event] ${JSON.stringify({
	                  detail: event.detail ?? event.title,
	                  command: commandPayload
	                    ? {
	                        id: commandPayload.id,
	                        command: commandPayload.command,
	                        status: commandPayload.status,
	                        exit_code: commandPayload.exit_code,
	                      }
	                    : null,
	                })}`,
	              );
	              let outputDelta: string | undefined;
	              if (commandPayload?.id && commandPayload.command) {
	                const nextOutput = String(commandPayload.aggregated_output ?? "");
	                const prevOutput = lastCommandOutputs.get(commandPayload.id) ?? "";
	                if (nextOutput !== prevOutput) {
	                  if (prevOutput && nextOutput.startsWith(prevOutput)) {
	                    outputDelta = nextOutput.slice(prevOutput.length);
	                  } else {
	                    outputDelta = nextOutput;
	                  }
	                  lastCommandOutputs.set(commandPayload.id, nextOutput);
	                }
	
	                if (!announcedCommandIds.has(commandPayload.id)) {
	                  announcedCommandIds.add(commandPayload.id);
	                  const header = `${hasCommandOutput ? "\n" : ""}$ ${commandPayload.command}\n`;
	                  outputDelta = header + (outputDelta ?? "");
	                  hasCommandOutput = true;
	                } else if (outputDelta) {
	                  hasCommandOutput = true;
	                }
	              }
	              safeJsonSend(ws, {
	                type: "command",
	                detail: event.detail ?? event.title,
	                command: commandPayload
	                  ? {
	                      id: commandPayload.id,
	                      command: commandPayload.command,
	                      status: commandPayload.status,
	                      exit_code: commandPayload.exit_code,
	                      outputDelta,
	                    }
	                  : undefined,
	              });
	              if (commandPayload?.command) {
	                historyStore.add(historyKey, { role: "status", text: `$ ${commandPayload.command}`, ts: Date.now(), kind: "command" });
	              }
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
            const expectedThreadId = sessionManager.getSavedThreadId(
              userId,
              orchestrator.getActiveAgentId(),
            );
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
                    summary: `✓ ${summary.agentName} 完成：${truncateForLog(summary.prompt, 140)}`,
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
            const threadId = orchestrator.getThreadId();
            const threadReset =
              Boolean(expectedThreadId) && Boolean(threadId) && expectedThreadId !== threadId;
	            safeJsonSend(ws, {
                type: "result",
                ok: true,
                output: outputToSend,
                threadId,
                expectedThreadId,
                threadReset,
              });
	            if (sessionLogger) {
	              sessionLogger.attachThreadId(threadId ?? undefined);
	              sessionLogger.logOutput(outputToSend);
	            }
            historyStore.add(historyKey, {
              role: "ai",
              text: outputToSend,
              ts: Date.now(),
            });
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
          });
          return;
        }

		      if (!isCommand) {
		        safeJsonSend(ws, { type: "error", message: "Unsupported message type" });
		        return;
		      }

          await taskQueueLock.runExclusive(async () => {
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
	      const isCdCommand = normalizedSlash === "cd";
      if (!isSilentCommandPayload && !isCdCommand) {
        sessionLogger?.logInput(command);
        historyStore.add(historyKey, { role: "user", text: command, ts: Date.now() });
      }

	      if (slash?.command === "vsearch") {
	        const query = slash.body.trim();
	        const workspaceRoot = detectWorkspaceFrom(currentCwd);
	        const output = await runVectorSearch({ workspaceRoot, query, entryNamespace: "web" });
	        const note =
	          "提示：系统会在后台自动用向量召回来补齐 agent 上下文；/vsearch 主要用于手动调试/查看原始召回结果。";
	        const decorated = output.startsWith("Vector search results for:") ? `${note}\n\n${output}` : output;
	        safeJsonSend(ws, { type: "result", ok: true, output: decorated });
	        sessionLogger?.logOutput(decorated);
	        historyStore.add(historyKey, { role: "ai", text: decorated, ts: Date.now() });
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
	          historyStore.add(historyKey, { role: "ai", text: output, ts: Date.now() });
	          return;
	        }
	        try {
	          const result = await SearchTool.search({ query }, { config });
	          const output = formatSearchResults(query, result);
	          safeJsonSend(ws, { type: "result", ok: true, output });
	          sessionLogger?.logOutput(output);
          historyStore.add(historyKey, { role: "ai", text: output, ts: Date.now() });
	        } catch (error) {
	          const message = error instanceof Error ? error.message : String(error);
	          const output = `/search 失败: ${message}`;
	          safeJsonSend(ws, { type: "result", ok: false, output });
	          sessionLogger?.logError(output);
	          historyStore.add(historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
	        }
	        return;
	      }
	      if (slash?.command === "pwd") {
	        const output = `当前工作目录: ${currentCwd}`;
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
	          const output = `错误: ${result.error}`;
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

        let message = `已切换到: ${currentCwd}`;
        if (prevCwd !== currentCwd) {
          message += "\n提示: 代理上下文已切换到新目录";
        } else {
          message += "\n提示: 已在相同目录，无需重置会话";
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
	            const output = "暂无可用代理";
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
        return;
	    });

    ws.on("close", (code, reason) => {
      clients.delete(ws);
      clientHistoryKeyByWs.delete(ws);
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

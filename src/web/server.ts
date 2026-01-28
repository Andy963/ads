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
import { closeAllStateDatabases, getStateDatabase, resolveStateDbPath } from "../state/database.js";
import { closeAllWorkspaceDatabases } from "../storage/database.js";

import { TaskQueue } from "../tasks/queue.js";
import { TaskStore as QueueTaskStore } from "../tasks/store.js";
import { OrchestratorTaskPlanner } from "../tasks/planner.js";
import { OrchestratorTaskExecutor } from "../tasks/executor.js";
import type { TaskStatus as QueueTaskStatus } from "../tasks/types.js";
import { AsyncLock } from "../utils/asyncLock.js";

import { AttachmentStore } from "../attachments/store.js";
import { detectImageInfo } from "../attachments/images.js";
import type { ImageAttachmentResponse } from "../attachments/types.js";
import { extractMultipartFile } from "./multipart.js";
import { TaskRunController } from "./taskRunController.js";
import { broadcastTaskStart } from "./taskStartBroadcast.js";
import { handleSingleTaskRun, matchSingleTaskRunPath } from "./api/taskRun.js";
import { parseCookies, serializeCookie } from "./auth/cookies.js";
import { isOriginAllowed, parseAllowedOrigins } from "./auth/origin.js";
import {
  ADS_SESSION_COOKIE_NAME,
  countUsers,
  createWebSession,
  findUserCredentialByUsername,
  lookupSessionByToken,
  refreshSessionIfNeeded,
  revokeSessionByTokenHash,
  resolveSessionPepper,
  resolveSessionTtlSeconds,
} from "./auth/sessions.js";
import { verifyPasswordScrypt } from "./auth/password.js";
import { ensureWebAuthTables } from "./auth/schema.js";

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
const stateDbPath = resolveStateDbPath();
const webThreadStorage = new ThreadStorage({
  namespace: "web",
  storagePath: path.join(adsStateDir, "web-threads.json"),
});
// Disable in-memory session timeout cleanup for Web (keep sessions until process exit / explicit reset).
const sessionManager = new SessionManager(0, 0, "workspace-write", "gpt-5.2", webThreadStorage);
const historyStore = new HistoryStore({
  storagePath: stateDbPath,
  namespace: "web",
  migrateFromPaths: [path.join(adsStateDir, "web-history.json")],
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = stateDbPath;
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
    case "queued":
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
  let shutdownHandled = false;
  const shutdown = (): void => {
    if (shutdownHandled) {
      return;
    }
    shutdownHandled = true;
    try {
      closeAllWorkspaceDatabases();
    } catch {
      // ignore
    }
    try {
      closeAllStateDatabases();
    } catch {
      // ignore
    }
    cleanup();
  };
  process.once("exit", shutdown);
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  return pidFile;
}

const allowedOrigins = parseAllowedOrigins(process.env.ADS_WEB_ALLOWED_ORIGINS);
const sessionTtlSeconds = resolveSessionTtlSeconds();
const sessionPepper = resolveSessionPepper();

function isRequestSecure(req: http.IncomingMessage): boolean {
  const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  if (xfProto === "https") {
    return true;
  }
  const forwarded = String(req.headers["forwarded"] ?? "").trim().toLowerCase();
  if (forwarded) {
    // Example: Forwarded: for=...;proto=https;host=...
    const match = /(?:^|;)\s*proto=([^;,\s]+)/.exec(forwarded);
    if (match && match[1] === "https") {
      return true;
    }
  }
  return false;
}

function resolveCookieSecure(req: http.IncomingMessage): boolean {
  const raw = String(process.env.ADS_WEB_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") {
    return isRequestSecure(req);
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return isRequestSecure(req);
}

function isStateChangingMethod(method: string | undefined): boolean {
  const m = String(method ?? "").toUpperCase();
  return m === "POST" || m === "PATCH" || m === "DELETE";
}

function resolveClientIp(req: http.IncomingMessage): string | null {
  const raw = req.headers["x-forwarded-for"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const candidate = String(first ?? "").split(",")[0]?.trim();
  return candidate || (req.socket.remoteAddress ? String(req.socket.remoteAddress) : null);
}

function getUserAgent(req: http.IncomingMessage): string | null {
  const raw = req.headers["user-agent"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function readSessionCookie(req: http.IncomingMessage): string | null {
  const cookies = parseCookies(req.headers["cookie"]);
  const token = cookies[ADS_SESSION_COOKIE_NAME];
  const trimmed = String(token ?? "").trim();
  return trimmed || null;
}

type RequestAuthContext =
  | { ok: true; userId: string; username: string; tokenHash: string; setCookie?: string }
  | { ok: false };

function buildSessionCookie(req: http.IncomingMessage, token: string, ttlSeconds: number): string {
  // Default to "auto": Secure only when the outer request is HTTPS.
  // This avoids browsers dropping Secure cookies on plain HTTP (common on localhost).
  // Override via ADS_WEB_COOKIE_SECURE=true/false.
  return serializeCookie(ADS_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: resolveCookieSecure(req),
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: ttlSeconds,
  });
}

function buildClearSessionCookie(req: http.IncomingMessage): string {
  return serializeCookie(ADS_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: resolveCookieSecure(req),
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: 0,
  });
}

function authenticateRequest(req: http.IncomingMessage): RequestAuthContext {
  const token = readSessionCookie(req);
  if (!token) {
    return { ok: false };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const lookup = lookupSessionByToken({ token, nowSeconds, ttlSeconds: sessionTtlSeconds, pepper: sessionPepper });
  if (!lookup.ok) {
    return { ok: false };
  }

  const ip = resolveClientIp(req);
  const agent = getUserAgent(req);
  const refreshed = refreshSessionIfNeeded({
    tokenHash: lookup.session.token_hash,
    nowSeconds,
    ttlSeconds: sessionTtlSeconds,
    lastSeenIp: ip,
    userAgent: agent,
    refresh: lookup.shouldRefresh,
  });

  const setCookie = lookup.shouldRefresh ? buildSessionCookie(req, token, sessionTtlSeconds) : undefined;
  void refreshed;
  return { ok: true, userId: lookup.user.id, username: lookup.user.username, tokenHash: lookup.session.token_hash, setCookie };
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
    if (url.startsWith("/api/")) {
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

async function start(): Promise<void> {
  const workspaceRoot = detectWorkspace();
  const allowedDirs = resolveAllowedDirs(workspaceRoot);

  const taskQueueLock = new AsyncLock();
  const taskQueueAvailable = parseBooleanFlag(process.env.TASK_QUEUE_ENABLED, true);
  const taskQueueAutoStart = parseBooleanFlag(process.env.TASK_QUEUE_AUTO_START, false);

  const clients: Set<WebSocket> = new Set();
  const clientMetaByWs = new Map<WebSocket, { historyKey: string; sessionId: string }>();

  const broadcastToSession = (sessionId: string, payload: unknown): void => {
    for (const [ws, meta] of clientMetaByWs.entries()) {
      if (meta.sessionId !== sessionId) {
        continue;
      }
      safeJsonSend(ws, payload);
    }
  };

  const recordToSessionHistories = (
    sessionId: string,
    entry: { role: string; text: string; ts: number; kind?: string },
  ): void => {
    for (const meta of clientMetaByWs.values()) {
      if (meta.sessionId !== sessionId) {
        continue;
      }
      try {
        historyStore.add(meta.historyKey, entry);
      } catch {
        // ignore
      }
    }
  };

  const TASK_QUEUE_METRIC_NAMES = [
    "TASK_ADDED",
    "TASK_STARTED",
    "PROMPT_INJECTED",
    "TASK_COMPLETED",
    "INJECTION_SKIPPED",
  ] as const;

  type TaskQueueMetricName = (typeof TASK_QUEUE_METRIC_NAMES)[number];

  type TaskQueueMetricEvent = {
    name: TaskQueueMetricName;
    ts: number;
    taskId?: string;
    reason?: string;
  };

  type TaskQueueMetrics = {
    counts: Record<TaskQueueMetricName, number>;
    events: TaskQueueMetricEvent[];
  };

  const createTaskQueueMetrics = (): TaskQueueMetrics => ({
    counts: Object.fromEntries(TASK_QUEUE_METRIC_NAMES.map((name) => [name, 0])) as Record<TaskQueueMetricName, number>,
    events: [],
  });

  const recordTaskQueueMetric = (
    metrics: TaskQueueMetrics,
    name: TaskQueueMetricName,
    event?: { ts?: number; taskId?: string; reason?: string },
  ): void => {
    metrics.counts[name] = (metrics.counts[name] ?? 0) + 1;
    metrics.events.push({
      name,
      ts: typeof event?.ts === "number" ? event.ts : Date.now(),
      taskId: event?.taskId,
      reason: event?.reason,
    });
    const maxEvents = 200;
    if (metrics.events.length > maxEvents) {
      metrics.events.splice(0, metrics.events.length - maxEvents);
    }
  };

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

  type TaskQueueContext = {
    workspaceRoot: string;
    sessionId: string;
    taskStore: QueueTaskStore;
    attachmentStore: AttachmentStore;
    taskQueue: TaskQueue;
    queueRunning: boolean;
    dequeueInProgress: boolean;
    metrics: TaskQueueMetrics;
    runController: TaskRunController;
    getStatusOrchestrator: () => ReturnType<SessionManager["getOrCreate"]>;
    getTaskQueueOrchestrator: (task: { id: string }) => ReturnType<SessionManager["getOrCreate"]>;
  };

  const taskContexts = new Map<string, TaskQueueContext>();

  const promoteQueuedTasksToPending = (ctx: TaskQueueContext): void => {
    if (!ctx.queueRunning) {
      return;
    }
    if (ctx.dequeueInProgress) {
      return;
    }
    ctx.dequeueInProgress = true;
    try {
      if (!ctx.queueRunning) {
        return;
      }
      // If something is still planning/running, do not dequeue to avoid double-starts.
      if (ctx.taskStore.getActiveTaskId()) {
        return;
      }

      const now = Date.now();
      let promoted = 0;
      while (true) {
        const dequeued = ctx.taskStore.dequeueNextQueuedTask(now);
        if (!dequeued) {
          break;
        }
        promoted += 1;
        broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: dequeued, ts: now });
      }
      if (promoted > 0) {
        ctx.taskQueue.notifyNewTask();
      }
    } finally {
      ctx.dequeueInProgress = false;
    }
  };

  const ensureTaskContext = (workspaceRootForContext: string): TaskQueueContext => {
    const key = String(workspaceRootForContext ?? "").trim() || workspaceRoot;
    const existing = taskContexts.get(key);
    if (existing) {
      return existing;
    }

    const sessionId = deriveProjectSessionId(key);
    const taskStore = new QueueTaskStore({ workspacePath: key });
    const attachmentStore = new AttachmentStore({ workspacePath: key });
    const taskQueueStatusUserId = 0;
    const taskQueueThreadStorage = new ThreadStorage({
      namespace: `task-queue:${sessionId}`,
      storagePath: path.join(adsStateDir, `task-queue-threads-${sessionId}.json`),
    });
    const taskQueueSessionManager = new SessionManager(
      0,
      0,
      "workspace-write",
      process.env.TASK_QUEUE_DEFAULT_MODEL,
      taskQueueThreadStorage,
    );
    const getStatusOrchestrator = () =>
      taskQueueSessionManager.getOrCreate(taskQueueStatusUserId, key, true);

    const getTaskQueueOrchestrator = (task: { id: string }) => {
      const userId = hashTaskId(task.id);
      return taskQueueSessionManager.getOrCreate(userId, key, true);
    };

    const planner = new OrchestratorTaskPlanner({
      getOrchestrator: getTaskQueueOrchestrator,
      planModel: process.env.TASK_QUEUE_PLAN_MODEL ?? "gpt-5.2",
      lock: taskQueueLock,
    });
    const executor = new OrchestratorTaskExecutor({
      getOrchestrator: getTaskQueueOrchestrator,
      store: taskStore,
      defaultModel: process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2",
      lock: taskQueueLock,
    });
    const taskQueue = new TaskQueue({ store: taskStore, planner, executor });

    const ctx: TaskQueueContext = {
      workspaceRoot: key,
      sessionId,
      taskStore,
      attachmentStore,
      taskQueue,
      queueRunning: false,
      dequeueInProgress: false,
      metrics: createTaskQueueMetrics(),
      runController: new TaskRunController(),
      getStatusOrchestrator,
      getTaskQueueOrchestrator,
    };
    taskContexts.set(key, ctx);

    taskQueue.on("task:started", ({ task }) => {
      const ts = Date.now();
      recordTaskQueueMetric(ctx.metrics, "TASK_STARTED", { ts, taskId: task.id });
      const prompt = String((task as { prompt?: unknown } | null)?.prompt ?? "").trim();
      if (!prompt) {
        logger.warn(`[Web] task prompt is empty; broadcasting placeholder taskId=${task.id}`);
      }
      broadcastTaskStart({
        task,
        ts,
        markPromptInjected: (taskId: string, now: number) => {
          try {
            return ctx.taskStore.markPromptInjected(taskId, now);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[Web] markPromptInjected failed taskId=${taskId} err=${message}`);
            throw error;
          }
        },
        recordHistory: (entry) => recordToSessionHistories(ctx.sessionId, entry),
        recordMetric: (name, event) => recordTaskQueueMetric(ctx.metrics, name as TaskQueueMetricName, event),
        broadcast: (payload) => broadcastToSession(sessionId, payload),
      });
    });
    taskQueue.on("task:planned", ({ task, plan }) =>
      broadcastToSession(sessionId, { type: "task:event", event: "task:planned", data: { task, plan }, ts: Date.now() }),
    );
    taskQueue.on("task:running", ({ task }) =>
      broadcastToSession(sessionId, { type: "task:event", event: "task:running", data: task, ts: Date.now() }),
    );
    taskQueue.on("step:started", ({ task, step }) =>
      broadcastToSession(sessionId, { type: "task:event", event: "step:started", data: { taskId: task.id, step }, ts: Date.now() }),
    );
    taskQueue.on("step:completed", ({ task, step }) =>
      broadcastToSession(sessionId, { type: "task:event", event: "step:completed", data: { taskId: task.id, step }, ts: Date.now() }),
    );
    taskQueue.on("message", ({ task, role, content }) =>
      broadcastToSession(sessionId, { type: "task:event", event: "message", data: { taskId: task.id, role, content }, ts: Date.now() }),
    );
    taskQueue.on("message:delta", ({ task, role, delta, modelUsed, source }) =>
      broadcastToSession(sessionId, { type: "task:event", event: "message:delta", data: { taskId: task.id, role, delta, modelUsed, source }, ts: Date.now() }),
    );
    taskQueue.on("command", ({ task, command }) => {
      broadcastToSession(sessionId, { type: "task:event", event: "command", data: { taskId: task.id, command }, ts: Date.now() });
      recordToSessionHistories(sessionId, { role: "status", text: `$ ${command}`, ts: Date.now(), kind: "command" });
    });
    taskQueue.on("task:completed", ({ task }) => {
      recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
      broadcastToSession(sessionId, { type: "task:event", event: "task:completed", data: task, ts: Date.now() });
      if (task.result && task.result.trim()) {
        recordToSessionHistories(sessionId, { role: "ai", text: task.result.trim(), ts: Date.now() });
      }
      if (ctx.runController.onTaskTerminal(ctx, task.id)) {
        return;
      }
      promoteQueuedTasksToPending(ctx);
    });
    taskQueue.on("task:failed", ({ task, error }) => {
      broadcastToSession(sessionId, { type: "task:event", event: "task:failed", data: { task, error }, ts: Date.now() });
      recordToSessionHistories(sessionId, { role: "status", text: `[Task failed] ${error}`, ts: Date.now(), kind: "error" });
      if (task.status === "failed") {
        recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
        if (ctx.runController.onTaskTerminal(ctx, task.id)) {
          return;
        }
        promoteQueuedTasksToPending(ctx);
      }
    });
    taskQueue.on("task:cancelled", ({ task }) => {
      broadcastToSession(sessionId, { type: "task:event", event: "task:cancelled", data: task, ts: Date.now() });
      recordToSessionHistories(sessionId, { role: "status", text: "[Cancelled]", ts: Date.now(), kind: "status" });
      recordTaskQueueMetric(ctx.metrics, "TASK_COMPLETED", { ts: Date.now(), taskId: task.id });
      if (ctx.runController.onTaskTerminal(ctx, task.id)) {
        return;
      }
      promoteQueuedTasksToPending(ctx);
    });

    if (taskQueueAvailable) {
      const status = getStatusOrchestrator().status();
      if (taskQueueAutoStart) {
        void taskQueue.start();
        ctx.queueRunning = true;
        logger.info(`[Web] TaskQueue started workspace=${key}`);
        promoteQueuedTasksToPending(ctx);
      } else {
        taskQueue.pause("manual");
        void taskQueue.start();
        ctx.queueRunning = false;
        logger.info(`[Web] TaskQueue paused workspace=${key}`);
      }
      if (!status.ready) {
        logger.warn(`[Web] Agent not ready yet; tasks may fail: ${status.error ?? "unknown"}`);
      }
    }

    return ctx;
  };

  const allowedDirValidator = new DirectoryManager(allowedDirs);

  const resolveTaskWorkspaceRoot = (url: URL): string => {
    const rawWorkspace = String(url.searchParams.get("workspace") ?? "").trim();
    if (!rawWorkspace) {
      return workspaceRoot;
    }

    const absolute = path.resolve(rawWorkspace);
    let resolved = absolute;
    try {
      resolved = fs.realpathSync(absolute);
    } catch {
      resolved = absolute;
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`Workspace does not exist: ${resolved}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Workspace not accessible: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${resolved}`);
    }

    const workspaceRootCandidate = detectWorkspaceFrom(resolved);
    let normalizedWorkspaceRoot = workspaceRootCandidate;
    try {
      normalizedWorkspaceRoot = fs.realpathSync(workspaceRootCandidate);
    } catch {
      normalizedWorkspaceRoot = workspaceRootCandidate;
    }

    if (!fs.existsSync(normalizedWorkspaceRoot)) {
      throw new Error(`Workspace root does not exist: ${normalizedWorkspaceRoot}`);
    }
    try {
      if (!fs.statSync(normalizedWorkspaceRoot).isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${normalizedWorkspaceRoot}`);
      }
    } catch {
      throw new Error(`Workspace root not accessible: ${normalizedWorkspaceRoot}`);
    }

    if (!allowedDirValidator.validatePath(normalizedWorkspaceRoot)) {
      throw new Error("Workspace is not allowed");
    }

    return normalizedWorkspaceRoot;
  };

  const resolveTaskContext = (url: URL): TaskQueueContext => {
    const targetWorkspaceRoot = resolveTaskWorkspaceRoot(url);
    return ensureTaskContext(targetWorkspaceRoot);
  };

  const server = createHttpServer({
    handleApiRequest: async (req, res) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const pathname = url.pathname;

      if (isStateChangingMethod(req.method) && !isOriginAllowed(req.headers["origin"], allowedOrigins)) {
        sendJson(res, 403, { error: "Forbidden" });
        return true;
      }

      if (req.method === "GET" && pathname === "/api/auth/status") {
        sendJson(res, 200, { initialized: countUsers() > 0 });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/auth/login") {
        const body = await readJsonBody(req);
        const schema = z.object({ username: z.string().min(1), password: z.string().min(1) }).passthrough();
        const parsed = schema.safeParse(body ?? {});
        if (!parsed.success) {
          sendJson(res, 400, { error: "Invalid payload" });
          return true;
        }
        const username = parsed.data.username.trim();
        const password = parsed.data.password;

        const db = getStateDatabase();
        ensureWebAuthTables(db);
        const cred = findUserCredentialByUsername(db, username);
        if (!cred || cred.disabled_at) {
          sendJson(res, 401, { error: "Unauthorized" });
          return true;
        }
        if (!verifyPasswordScrypt(password, cred.password_hash)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return true;
        }

        const nowSeconds = Math.floor(Date.now() / 1000);
        const ip = resolveClientIp(req);
        const agent = getUserAgent(req);
        const created = createWebSession({
          userId: cred.id,
          nowSeconds,
          ttlSeconds: sessionTtlSeconds,
          pepper: sessionPepper,
          lastSeenIp: ip,
          userAgent: agent,
        });

        db.prepare("UPDATE web_users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(
          nowSeconds,
          nowSeconds,
          cred.id,
        );

        res.setHeader("Set-Cookie", buildSessionCookie(req, created.token, sessionTtlSeconds));
        sendJson(res, 200, { success: true });
        return true;
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const auth = authenticateRequest(req);
        res.setHeader("Set-Cookie", buildClearSessionCookie(req));
        if (!auth.ok) {
          sendJson(res, 200, { success: true });
          return true;
        }
        revokeSessionByTokenHash({ tokenHash: auth.tokenHash });
        sendJson(res, 200, { success: true });
        return true;
      }

      if (pathname === "/api/auth/me" && req.method === "GET") {
        const auth = authenticateRequest(req);
        if (!auth.ok) {
          sendJson(res, 401, { error: "Unauthorized" });
          return true;
        }
        if (auth.setCookie) {
          res.setHeader("Set-Cookie", auth.setCookie);
        }
        sendJson(res, 200, { id: auth.userId, username: auth.username });
        return true;
      }

      const auth = authenticateRequest(req);
      if (!auth.ok) {
        sendJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      if (auth.setCookie) {
        res.setHeader("Set-Cookie", auth.setCookie);
      }

      const buildAttachmentRawUrl = (attachmentId: string): string => {
        const workspaceParam = url.searchParams.get("workspace");
        if (!workspaceParam) {
          return `/api/attachments/${encodeURIComponent(attachmentId)}/raw`;
        }
        const qp = `workspace=${encodeURIComponent(workspaceParam)}`;
        return `/api/attachments/${encodeURIComponent(attachmentId)}/raw?${qp}`;
      };

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
        const ctx = resolveTaskContext(url);
        const models = ctx.taskStore.listModelConfigs().filter((m) => m.isEnabled);
        sendJson(res, 200, models);
        return true;
      }

      if (pathname === "/api/model-configs") {
        const ctx = resolveTaskContext(url);
        if (req.method === "GET") {
          sendJson(res, 200, ctx.taskStore.listModelConfigs());
          return true;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const schema = z
            .object({
              id: z.string().min(1),
              displayName: z.string().min(1),
              provider: z.string().min(1),
              isEnabled: z.boolean().optional(),
              isDefault: z.boolean().optional(),
              configJson: z.record(z.unknown()).nullable().optional(),
            })
            .passthrough();
          const parsed = schema.safeParse(body ?? {});
          if (!parsed.success) {
            sendJson(res, 400, { error: "Invalid payload" });
            return true;
          }
          const modelId = parsed.data.id.trim();
          if (!modelId || modelId.toLowerCase() === "auto") {
            sendJson(res, 400, { error: "Invalid model id" });
            return true;
          }
          const saved = ctx.taskStore.upsertModelConfig({
            id: modelId,
            displayName: parsed.data.displayName.trim(),
            provider: parsed.data.provider.trim(),
            isEnabled: parsed.data.isEnabled ?? true,
            isDefault: parsed.data.isDefault ?? false,
            configJson: parsed.data.configJson ?? null,
          });
          sendJson(res, 200, saved);
          return true;
        }
      }

      const modelConfigMatch = /^\/api\/model-configs\/([^/]+)$/.exec(pathname);
      if (modelConfigMatch?.[1]) {
        const modelId = String(modelConfigMatch[1]).trim();
        const ctx = resolveTaskContext(url);

        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const schema = z
            .object({
              displayName: z.string().min(1).optional(),
              provider: z.string().min(1).optional(),
              isEnabled: z.boolean().optional(),
              isDefault: z.boolean().optional(),
              configJson: z.record(z.unknown()).nullable().optional(),
            })
            .passthrough();
          const parsed = schema.safeParse(body ?? {});
          if (!parsed.success) {
            sendJson(res, 400, { error: "Invalid payload" });
            return true;
          }

          const existing = ctx.taskStore.getModelConfig(modelId);
          if (!existing) {
            sendJson(res, 404, { error: "Not found" });
            return true;
          }

          const saved = ctx.taskStore.upsertModelConfig({
            ...existing,
            displayName: parsed.data.displayName === undefined ? existing.displayName : parsed.data.displayName.trim(),
            provider: parsed.data.provider === undefined ? existing.provider : parsed.data.provider.trim(),
            isEnabled: parsed.data.isEnabled === undefined ? existing.isEnabled : parsed.data.isEnabled,
            isDefault: parsed.data.isDefault === undefined ? existing.isDefault : parsed.data.isDefault,
            configJson: parsed.data.configJson === undefined ? (existing.configJson ?? null) : parsed.data.configJson,
          });
          sendJson(res, 200, saved);
          return true;
        }

        if (req.method === "DELETE") {
          const existing = ctx.taskStore.getModelConfig(modelId);
          if (!existing) {
            sendJson(res, 404, { error: "Not found" });
            return true;
          }
          if (existing.isDefault) {
            sendJson(res, 400, { error: "Cannot delete default model" });
            return true;
          }
          const deleted = ctx.taskStore.deleteModelConfig(modelId);
          sendJson(res, 200, { success: deleted });
          return true;
        }
      }

      if (req.method === "GET" && pathname === "/api/task-queue/status") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const status = ctx.getStatusOrchestrator().status();
        sendJson(res, 200, { enabled: taskQueueAvailable, running: ctx.queueRunning, ...status });
        return true;
      }

      if (req.method === "GET" && pathname === "/api/task-queue/metrics") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        sendJson(res, 200, { workspaceRoot: ctx.workspaceRoot, running: ctx.queueRunning, ...ctx.metrics });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/task-queue/run") {
        if (!taskQueueAvailable) {
          sendJson(res, 409, { error: "Task queue disabled" });
          return true;
        }
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        ctx.runController.setModeAll();
        ctx.taskQueue.resume();
        ctx.queueRunning = true;
        promoteQueuedTasksToPending(ctx);
        const status = ctx.getStatusOrchestrator().status();
        sendJson(res, 200, { success: true, enabled: taskQueueAvailable, running: ctx.queueRunning, ...status });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/task-queue/pause") {
        if (!taskQueueAvailable) {
          sendJson(res, 409, { error: "Task queue disabled" });
          return true;
        }
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        ctx.runController.setModeManual();
        ctx.taskQueue.pause("manual");
        ctx.queueRunning = false;
        const status = ctx.getStatusOrchestrator().status();
        sendJson(res, 200, { success: true, enabled: taskQueueAvailable, running: ctx.queueRunning, ...status });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/attachments/images") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }

        const contentTypeHeader = String(req.headers["content-type"] ?? "").trim();
        let raw: Buffer;
        try {
          raw = await readRawBody(req, { maxBytes: 6 * 1024 * 1024 });
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const message = rawMessage === "Request body too large" ? "Image too large" : rawMessage;
          sendJson(res, 413, { error: message });
          return true;
        }

        let filePart;
        try {
          filePart = extractMultipartFile(raw, contentTypeHeader, "file");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        if (!filePart) {
          sendJson(res, 400, { error: "Missing multipart field: file" });
          return true;
        }
        const bytes = filePart.data;
        if (!bytes || bytes.length === 0) {
          sendJson(res, 400, { error: "Empty file" });
          return true;
        }
        if (bytes.length > 5 * 1024 * 1024) {
          sendJson(res, 413, { error: "Image too large (>5MB)" });
          return true;
        }

        const info = detectImageInfo(bytes);
        if (!info) {
          sendJson(res, 415, { error: "Unsupported image type" });
          return true;
        }
        if (!["image/png", "image/jpeg", "image/webp"].includes(info.contentType)) {
          sendJson(res, 415, { error: "Unsupported image content-type" });
          return true;
        }

        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        const storageKey = `attachments/${sha256.slice(0, 2)}/${sha256}.${info.ext}`;
        const absPath = resolveWorkspaceStatePath(ctx.workspaceRoot, storageKey);

        // Ensure bytes are persisted under content-addressed key.
        try {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          if (!fs.existsSync(absPath)) {
            fs.writeFileSync(absPath, bytes);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 500, { error: `Failed to store image: ${message}` });
          return true;
        }

        let attachment;
        try {
          attachment = ctx.attachmentStore.createOrGetImageAttachment({
            filename: filePart.filename,
            contentType: info.contentType,
            sizeBytes: bytes.length,
            width: info.width,
            height: info.height,
            sha256,
            storageKey,
            now: Date.now(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 500, { error: message });
          return true;
        }

        const payload: ImageAttachmentResponse = {
          id: attachment.id,
          url: buildAttachmentRawUrl(attachment.id),
          sha256: attachment.sha256,
          width: attachment.width,
          height: attachment.height,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
        };
        sendJson(res, 201, payload);
        return true;
      }

      const attachmentRawMatch = /^\/api\/attachments\/([^/]+)\/raw$/.exec(pathname);
      if (attachmentRawMatch && req.method === "GET") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        let id = "";
        try {
          id = decodeURIComponent(attachmentRawMatch[1] ?? "").trim();
        } catch {
          sendJson(res, 400, { error: "Invalid attachment id" });
          return true;
        }
        const attachment = ctx.attachmentStore.getAttachment(id);
        if (!attachment) {
          sendJson(res, 404, { error: "Attachment not found" });
          return true;
        }
        if (attachment.kind !== "image") {
          sendJson(res, 415, { error: "Unsupported attachment kind" });
          return true;
        }
        const absPath = resolveWorkspaceStatePath(ctx.workspaceRoot, attachment.storageKey);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absPath);
          if (!stat.isFile()) {
            sendJson(res, 404, { error: "Attachment not found" });
            return true;
          }
        } catch {
          sendJson(res, 404, { error: "Attachment not found" });
          return true;
        }

        const etag = `"sha256-${attachment.sha256}"`;
        const ifNoneMatch = String(req.headers["if-none-match"] ?? "").trim();
        if (ifNoneMatch && ifNoneMatch === etag) {
          res.writeHead(304, {
            ETag: etag,
            "Cache-Control": "private, max-age=31536000, immutable",
          });
          res.end();
          return true;
        }

        res.writeHead(200, {
          "Content-Type": attachment.contentType,
          "Content-Length": String(stat.size),
          "Cache-Control": "private, max-age=31536000, immutable",
          ETag: etag,
        });
        fs.createReadStream(absPath).pipe(res);
        return true;
      }

      if (req.method === "GET" && pathname === "/api/tasks") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const status = parseTaskStatus(url.searchParams.get("status"));
        const limitRaw = url.searchParams.get("limit")?.trim();
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
        const tasks = ctx.taskStore.listTasks({ status, limit });
        const enriched = tasks.map((task) => {
          const attachments = ctx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
            id: a.id,
            url: buildAttachmentRawUrl(a.id),
            sha256: a.sha256,
            width: a.width,
            height: a.height,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            filename: a.filename,
          }));
          return { ...task, attachments };
        });
        sendJson(res, 200, enriched);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/tasks") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const body = await readJsonBody(req);
        const schema = z
          .object({
            title: z.string().min(1).optional(),
            prompt: z.string().min(1),
            model: z.string().optional(),
            priority: z.number().optional(),
            inheritContext: z.boolean().optional(),
            maxRetries: z.number().optional(),
            attachments: z.array(z.string().min(1)).optional(),
          })
          .passthrough();
        const parsed = schema.parse(body ?? {});
        const now = Date.now();
        const attachmentIds = (parsed.attachments ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
        const taskId = crypto.randomUUID();
        let task: ReturnType<QueueTaskStore["createTask"]>;
        try {
          task = ctx.taskStore.createTask(
            {
              id: taskId,
              title: parsed.title,
              prompt: parsed.prompt,
              model: parsed.model,
              priority: parsed.priority,
              inheritContext: parsed.inheritContext,
              maxRetries: parsed.maxRetries,
              createdBy: "web",
            },
            now,
            undefined,
          );

          if (attachmentIds.length > 0) {
            ctx.attachmentStore.assignAttachmentsToTask(task.id, attachmentIds);
          }
        } catch (error) {
          // Best-effort rollback: keep task+attachment association consistent.
          try {
            ctx.taskStore.deleteTask(taskId);
          } catch {
            // ignore rollback errors
          }
          const message = error instanceof Error ? error.message : String(error);
          const lower = message.toLowerCase();
          const status =
            lower.includes("already assigned") || lower.includes("conflict") ? 409
              : lower.includes("not found") ? 400
                : 400;
          sendJson(res, status, { error: message });
          return true;
        }

        const attachments = ctx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
          id: a.id,
          url: buildAttachmentRawUrl(a.id),
          sha256: a.sha256,
          width: a.width,
          height: a.height,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          filename: a.filename,
        }));

        recordTaskQueueMetric(ctx.metrics, "TASK_ADDED", { ts: now, taskId: task.id });
        if (ctx.queueRunning) {
          ctx.taskQueue.notifyNewTask();
        }
        broadcastToSession(ctx.sessionId, {
          type: "task:event",
          event: "task:updated",
          data: { ...task, attachments },
          ts: now,
        });
        sendJson(res, 201, { ...task, attachments });
        return true;
      }

      const retryMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);
      if (retryMatch && req.method === "POST") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const taskId = retryMatch[1] ?? "";
        ctx.taskQueue.retry(taskId);
        const task = ctx.taskStore.getTask(taskId);
        if (task) {
          broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
        }
        sendJson(res, 200, { success: true, task });
        return true;
      }

      const runSingleTaskId = matchSingleTaskRunPath(pathname);
      if (runSingleTaskId && req.method === "POST") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const now = Date.now();
        const result = handleSingleTaskRun({
          taskQueueAvailable,
          controller: ctx.runController,
          ctx,
          taskId: runSingleTaskId,
          now,
        });

        if ("task" in result && result.task) {
          broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: result.task, ts: now });
        }
        sendJson(res, result.status, result.body);
        return true;
      }

      if (req.method === "POST" && pathname === "/api/tasks/reorder") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const body = await readJsonBody(req);
        const schema = z.object({ ids: z.array(z.string().min(1)).min(1) }).passthrough();
        const parsed = schema.parse(body ?? {});
        const ids = parsed.ids.map((id) => String(id ?? "").trim()).filter(Boolean);
        let updated: ReturnType<QueueTaskStore["reorderPendingTasks"]>;
        try {
          updated = ctx.taskStore.reorderPendingTasks(ids);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const enriched = updated.map((task) => {
          const attachments = ctx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
            id: a.id,
            url: buildAttachmentRawUrl(a.id),
            sha256: a.sha256,
            width: a.width,
            height: a.height,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            filename: a.filename,
          }));
          return { ...task, attachments };
        });

        for (const task of enriched) {
          broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
        }
        sendJson(res, 200, { success: true, tasks: enriched });
        return true;
      }

      const moveMatch = /^\/api\/tasks\/([^/]+)\/move$/.exec(pathname);
      if (moveMatch && req.method === "POST") {
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        if (ctx.queueRunning) {
          sendJson(res, 409, { error: "Task queue is running" });
          return true;
        }
        const taskId = moveMatch[1] ?? "";
        const body = await readJsonBody(req);
        const schema = z.object({ direction: z.enum(["up", "down"]) }).passthrough();
        const parsed = schema.parse(body ?? {});
        const updated = ctx.taskStore.movePendingTask(taskId, parsed.direction);
        if (!updated) {
          sendJson(res, 200, { success: true, tasks: [] });
          return true;
        }
        for (const task of updated) {
          broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: Date.now() });
        }
        sendJson(res, 200, { success: true, tasks: updated });
        return true;
      }

      const chatMatch = /^\/api\/tasks\/([^/]+)\/chat$/.exec(pathname);
      if (chatMatch && req.method === "POST") {
        if (!taskQueueAvailable) {
          sendJson(res, 409, { error: "Task queue disabled" });
          return true;
        }
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const taskId = chatMatch[1] ?? "";
        const task = ctx.taskStore.getTask(taskId);
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
          ctx.taskStore.addMessage({
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
        broadcastToSession(ctx.sessionId, { type: "task:event", event: "message", data: { taskId: task.id, role: "user", content }, ts: Date.now() });

        void taskQueueLock.runExclusive(async () => {
          const latest = ctx.taskStore.getTask(taskId);
          if (!latest || latest.status === "cancelled") {
            return;
          }
          const desiredModel = String(latest.model ?? "").trim() || "auto";
          const modelToUse = desiredModel === "auto" ? (process.env.TASK_QUEUE_DEFAULT_MODEL ?? "gpt-5.2") : desiredModel;
          const orchestrator = ctx.getTaskQueueOrchestrator(latest);
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
                  broadcastToSession(ctx.sessionId, {
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
                    ctx.taskStore.addMessage({
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
                  broadcastToSession(ctx.sessionId, { type: "task:event", event: "command", data: { taskId: latest.id, command }, ts: Date.now() });
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
              ctx.taskStore.addMessage({
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
            broadcastToSession(ctx.sessionId, { type: "task:event", event: "message", data: { taskId: latest.id, role: "assistant", content: text }, ts: Date.now() });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            broadcastToSession(ctx.sessionId, { type: "task:event", event: "message", data: { taskId: taskId, role: "system", content: `[Chat failed] ${msg}` }, ts: Date.now() });
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
        let ctx: TaskQueueContext;
        try {
          ctx = resolveTaskContext(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return true;
        }
        const taskId = taskMatch[1] ?? "";

        if (req.method === "GET") {
          const task = ctx.taskStore.getTask(taskId);
          if (!task) {
            sendJson(res, 404, { error: "Not Found" });
            return true;
          }
          const attachments = ctx.attachmentStore.listAttachmentsForTask(task.id).map((a) => ({
            id: a.id,
            url: buildAttachmentRawUrl(a.id),
            sha256: a.sha256,
            width: a.width,
            height: a.height,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
            filename: a.filename,
          }));
          sendJson(res, 200, {
            ...task,
            attachments,
            plan: ctx.taskStore.getPlan(taskId),
            messages: ctx.taskStore.getMessages(taskId),
          });
          return true;
        }

        if (req.method === "DELETE") {
          ctx.taskStore.deleteTask(taskId);
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
              ctx.taskQueue.pause("api");
              ctx.queueRunning = false;
              ctx.runController.setModeManual();
            } else if (parsed.action === "resume") {
              ctx.taskQueue.resume();
              ctx.queueRunning = true;
              ctx.runController.setModeAll();
            } else if (parsed.action === "cancel") {
              ctx.taskQueue.cancel(taskId);
              const task = ctx.taskStore.getTask(taskId);
              if (task) {
                broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:cancelled", data: task, ts: Date.now() });
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

          const existing = ctx.taskStore.getTask(taskId);
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

          const updated = ctx.taskStore.updateTask(taskId, updates, Date.now());
          if (ctx.queueRunning) {
            ctx.taskQueue.notifyNewTask();
          }
          broadcastToSession(ctx.sessionId, { type: "task:event", event: "task:updated", data: updated, ts: Date.now() });
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

    const parseProtocols = (protocols: string[]): { session?: string } => {
      let session: string | undefined;

      for (let i = 0; i < protocols.length; i++) {
        const entry = protocols[i];
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
      return { session };
    };

    if (!isOriginAllowed(req.headers["origin"], allowedOrigins)) {
      ws.close(4403, "forbidden");
      return;
    }

    const auth = authenticateRequest(req);
    if (!auth.ok) {
      ws.close(4401, "unauthorized");
      return;
    }

    const { session: wsSession } = parseProtocols(parsedProtocols);
    const sessionId = wsSession && wsSession.trim() ? wsSession.trim() : crypto.randomBytes(4).toString("hex");

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

    const clientKey = auth.userId;
    const userId = deriveWebUserId(clientKey, sessionId);
    const historyKey = `${clientKey}::${sessionId}`;
    clientMetaByWs.set(ws, { historyKey, sessionId });
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
      threadId: sessionManager.getSavedThreadId(userId, orchestrator.getActiveAgentId()),
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
      aliveWs.isAlive = true;
      aliveWs.missedPongs = 0;
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
        safeJsonSend(ws, { type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
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
	          const userLogEntry = buildUserLogEntry(promptInput.input, currentCwd);
	          sessionLogger?.logInput(userLogEntry);
	          historyStore.add(historyKey, { role: "user", text: userLogEntry, ts: Date.now() });
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
	          const lastCommandOutputsByKey = new Map<string, string>();
	          const announcedCommandKeys = new Set<string>();
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

		              const commandLine = commandPayload?.command ? String(commandPayload.command) : "";
		              const commandKey = commandLine
		                ? commandPayload?.id
		                  ? `id:${commandPayload.id}`
		                  : `cmd:${commandLine}`
		                : "";

		              if (!commandPayload || !commandLine || !commandKey) {
		                return;
		              }

		              let outputDelta: string | undefined;
		              const nextOutput = String(commandPayload.aggregated_output ?? "");
		              const prevOutput = lastCommandOutputsByKey.get(commandKey) ?? "";
		              if (nextOutput !== prevOutput) {
		                if (prevOutput && nextOutput.startsWith(prevOutput)) {
		                  outputDelta = nextOutput.slice(prevOutput.length);
		                } else {
		                  outputDelta = nextOutput;
		                }
		                lastCommandOutputsByKey.set(commandKey, nextOutput);
		              }

		              const isNewCommand = !announcedCommandKeys.has(commandKey);
		              if (isNewCommand) {
		                announcedCommandKeys.add(commandKey);
		                const header = `${hasCommandOutput ? "\n" : ""}$ ${commandLine}\n`;
		                outputDelta = header + (outputDelta ?? "");
		                hasCommandOutput = true;
		              } else if (outputDelta) {
		                hasCommandOutput = true;
		              }

		              // Avoid spamming the UI with multiple events for the same command unless there's new output to stream.
		              if (!isNewCommand && !outputDelta) {
		                return;
		              }

		              safeJsonSend(ws, {
		                type: "command",
		                detail: event.detail ?? event.title,
		                command: {
		                  id: commandPayload.id,
		                  command: commandLine,
		                  status: commandPayload.status,
		                  exit_code: commandPayload.exit_code,
		                  outputDelta,
		                },
		              });

		              if (isNewCommand) {
		                historyStore.add(historyKey, {
		                  role: "status",
		                  text: `$ ${commandLine}`,
		                  ts: Date.now(),
		                  kind: "command",
		                });
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
	      clientMetaByWs.delete(ws);
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
  try {
    closeAllWorkspaceDatabases();
  } catch {
    // ignore
  }
  try {
    closeAllStateDatabases();
  } catch {
    // ignore
  }
  process.exit(1);
});

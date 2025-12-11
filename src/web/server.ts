import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";
import childProcess from "node:child_process";
import type {
  CommandExecutionItem,
  Input,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ThreadEvent,
  TodoListItem,
} from "@openai/codex-sdk";

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
import { injectToolGuide, resolveToolInvocations } from "../agents/tools.js";
import { syncWorkspaceTemplates } from "../workspace/service.js";
import { HistoryStore } from "../utils/historyStore.js";

function loadCwdStore(filePath: string): Map<string, string> {
  try {
    if (!fs.existsSync(filePath)) return new Map();
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(data || {}));
  } catch {
    return new Map();
  }
}

function persistCwdStore(filePath: string, store: Map<string, string>): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of store.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

interface WsMessage {
  type: string;
  payload?: unknown;
}

interface IncomingImage {
  name?: string;
  mime?: string;
  data?: string;
  size?: number;
}

interface PromptPayload {
  text?: string;
  images?: IncomingImage[];
}

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
  storagePath: path.join(process.cwd(), ".ads", "web-history.json"),
  maxEntriesPerSession: 200,
  maxTextLength: 4000,
});
const cwdStorePath = path.join(process.cwd(), ".ads", "web-cwd.json");
const cwdStore = loadCwdStore(cwdStorePath);

function log(...args: unknown[]): void {
  logger.info(args.map((a) => String(a)).join(" "));
}

function isProcessRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0), true;
  } catch {
    return false;
  }
}

function readCmdline(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

function isLikelyWebProcess(pid: number): boolean {
  const cmdline = readCmdline(pid);
  if (!cmdline) return false;
  return (
    cmdline.includes("dist/src/web/server.js") ||
    cmdline.includes("src/web/server.ts") ||
    cmdline.includes("ads web") ||
    cmdline.includes("web/server")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveWebUserId(token: string, sessionId: string): number {
  const base = `${token || "default"}::${sessionId || "default"}`;
  const hash = crypto.createHash("sha256").update(base).digest();
  // Use a high offset to avoid collision with Telegram user IDs (int32)
  const value = hash.readUInt32BE(0);
  return 0x70000000 + value;
}

function truncateForLog(text: string, limit = 96): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function applyToolGuide(input: Input): Input {
  if (typeof input === "string") {
    return injectToolGuide(input);
  }
  if (Array.isArray(input)) {
    const guide = injectToolGuide("");
    if (guide.trim()) {
      return [{ type: "text", text: guide }, ...input];
    }
    return input;
  }
  return input;
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

function resolveAllowedDirs(workspaceRoot: string): string[] {
  const raw = process.env.ALLOWED_DIRS;
  const list = (raw ? raw.split(",") : [workspaceRoot]).map((dir) => dir.trim()).filter(Boolean);
  const resolved = list.map((dir) => path.resolve(dir));
  return resolved.length > 0 ? resolved : [workspaceRoot];
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

function sanitizeInput(input: unknown): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && "command" in (input as Record<string, unknown>)) {
    const command = (input as Record<string, unknown>).command;
    return typeof command === "string" ? command : null;
  }
  return null;
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

function getWorkspaceState(workspaceRoot: string): { path: string; rules: string; modified: string[] } {
  const rulesPath = path.join(workspaceRoot, ".ads", "rules.md");
  let modified: string[] = [];
  try {
    const gitStatus = childProcess.execSync("git status --porcelain", {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    modified = gitStatus
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[A-Z?]{1,2}\s+/, ""));
  } catch {
    modified = [];
  }
  return {
    path: workspaceRoot,
    rules: rulesPath,
    modified,
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

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/svg+xml"]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function resolveImageExt(name: string | undefined, mime: string | undefined): string {
  const safeName = name ? path.basename(name) : "";
  const extFromName = safeName.includes(".") ? path.extname(safeName).toLowerCase() : "";
  if (extFromName) return extFromName;
  if (!mime) return ".jpg";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/bmp") return ".bmp";
  if (mime === "image/svg+xml") return ".svg";
  return ".jpg";
}

function decodeBase64Data(data: string): Buffer {
  const base64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
  return Buffer.from(base64, "base64");
}

function persistIncomingImage(image: IncomingImage, imageDir: string): { ok: true; path: string } | { ok: false; message: string } {
  if (!image.data) {
    return { ok: false, message: "图片缺少数据" };
  }
  const mime = typeof image.mime === "string" ? image.mime : "";
  if (mime && !ALLOWED_IMAGE_MIME.has(mime)) {
    return { ok: false, message: `不支持的图片类型: ${mime}` };
  }
  const buffer = decodeBase64Data(image.data);
  const size = buffer.byteLength;
  if (size <= 0) {
    return { ok: false, message: "图片内容为空" };
  }
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, message: `图片超过 2MB 限制 (${Math.round(size / 1024)}KB)` };
  }
  const ext = resolveImageExt(image.name, mime);
  const filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
  fs.mkdirSync(imageDir, { recursive: true });
  const filePath = path.join(imageDir, filename);
  fs.writeFileSync(filePath, buffer);
  return { ok: true, path: filePath };
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function buildPromptInput(payload: unknown, imageDir: string): { ok: true; input: Input; attachments: string[] } | { ok: false, message: string } {
  const tempPaths: string[] = [];
  if (typeof payload === "string") {
    const text = sanitizeInput(payload);
    if (!text) {
      return { ok: false, message: "Payload must be a text prompt" };
    }
    return { ok: true, input: text, attachments: tempPaths };
  }
  const inputParts: Exclude<Input, string> = [];
  const parsed = (payload ?? {}) as PromptPayload;
  const text = sanitizeInput(parsed.text);
  if (text) {
    inputParts.push({ type: "text", text });
  }

  if (Array.isArray(parsed.images) && parsed.images.length > 0) {
    for (const image of parsed.images) {
      const result = persistIncomingImage(image, imageDir);
      if (!result.ok) {
        cleanupTempFiles(tempPaths);
        return { ok: false, message: result.message };
      }
      tempPaths.push(result.path);
      inputParts.push({ type: "local_image", path: result.path });
    }
  }

  if (inputParts.length === 0) {
    cleanupTempFiles(tempPaths);
    return { ok: false, message: "payload 不能为空" };
  }

  if (inputParts.length === 1 && inputParts[0].type === "text") {
    return { ok: true, input: inputParts[0].text, attachments: tempPaths };
  }
  return { ok: true, input: inputParts, attachments: tempPaths };
}

function formatAttachmentList(paths: string[], cwd: string): string {
  return paths
    .map((p) => {
      const rel = path.relative(cwd, p);
      if (rel && !rel.startsWith("..")) {
        return rel;
      }
      return path.basename(p);
    })
    .join(", ");
}

function buildUserLogEntry(input: Input, cwd: string): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed || "(no text)";
  }

  const lines: string[] = [];
  const textParts = input
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);
  if (textParts.length) {
    lines.push(textParts.join("\n"));
  }

  const imageParts = input
    .filter((part): part is { type: "local_image"; path: string } => part.type === "local_image")
    .map((part) => part.path);
  if (imageParts.length) {
    lines.push(`Images: ${formatAttachmentList(imageParts, cwd)}`);
  }

  return lines.length ? lines.join("\n") : "(no text)";
}

function renderLandingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>ADS Web Console</title>
  <style>
    :root {
      --vh: 100vh;
      --header-h: 64px;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --border: #d6d9e0;
      --text: #0f172a;
      --muted: #4b5563;
      --accent: #2563eb;
      --user: #f7f7f9;
      --ai: #eef1f5;
      --status: #f3f4f6;
      --code: #0f172a;
    }
    * { box-sizing: border-box; }
    html { height: 100%; width: 100%; overflow: hidden; }
    body { font-family: "Inter", "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; display: flex; flex-direction: column; }
    header { padding: 10px 14px; background: var(--panel); border-bottom: 1px solid var(--border); box-shadow: 0 1px 3px rgba(15,23,42,0.06); display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
    .header-row { display: flex; align-items: center; gap: 10px; justify-content: flex-start; width: 100%; }
    .header-left { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .ws-indicator { width: 12px; height: 12px; border-radius: 999px; background: #ef4444; border: 1px solid #e5e7eb; box-shadow: 0 0 0 2px #fff; }
    .ws-indicator.connecting { background: #f59e0b; box-shadow: 0 0 0 2px #fef3c7; animation: pulse 1s infinite alternate; }
    .ws-indicator.connected { background: #22c55e; box-shadow: 0 0 0 2px #dcfce7; animation: pulse 1s infinite alternate-reverse; }
    @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.15); } }
    header h1 { margin: 0; font-size: 16px; }
    .tab-bar { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
    .tabs-scroll { display: flex; gap: 6px; overflow-x: auto; padding: 0 2px; background: transparent; border: none; scrollbar-width: thin; flex: 1; min-width: 0; }
    .session-tab { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border-radius: 8px; border: 1px solid #e5e7eb; background: #fff; font-size: 12px; line-height: 1.2; cursor: pointer; white-space: nowrap; }
    .session-tab.active { border-color: #c7d2fe; background: #eef2ff; color: #1e1b4b; box-shadow: 0 1px 2px rgba(31,41,55,0.08); }
    .session-tab .label { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .session-tab .close { border: none; background: transparent; cursor: pointer; color: #9ca3af; font-size: 11px; }
    .session-tab .close:hover { color: #ef4444; }
    .tab-icons { display: inline-flex; gap: 6px; flex-shrink: 0; }
    .tab-icons button { width: 30px; height: 28px; border-radius: 8px; border: 1px solid #d6d9e0; background: #fff; cursor: pointer; }
    .tab-icons button:hover { border-color: #c7d2fe; background: #eef2ff; }
    .session-panel { display: flex; flex-direction: column; gap: 6px; }
    .session-current { font-size: 13px; color: var(--text); word-break: break-all; display: flex; align-items: center; gap: 6px; }
    .session-pill { display: inline-flex; align-items: center; justify-content: center; padding: 4px 8px; border-radius: 999px; background: #eef2ff; color: #312e81; font-weight: 700; min-width: 56px; max-width: 100%; }
    .session-rename { border: 1px solid #d6d9e0; background: #fff; color: #4b5563; border-radius: 8px; padding: 4px 6px; font-size: 12px; cursor: pointer; }
    .session-rename:hover { border-color: #c7d2fe; color: #312e81; }
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 10px 12px 8px; display: flex; gap: 10px; flex: 1; min-height: 0; overflow: hidden; }
    #sidebar { width: 240px; min-width: 220px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; box-shadow: 0 4px 12px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 10px; }
    .sidebar-title { font-size: 13px; font-weight: 600; margin: 0; color: var(--muted); }
    .workspace-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
    .workspace-list .path { color: var(--text); word-break: break-all; }
    .files-list { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text); max-height: 260px; overflow-y: auto; }
    #console { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; overflow: hidden; }
    #log { position: relative; overflow-y: auto; overflow-x: hidden; padding: 14px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 22px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 12px; scrollbar-gutter: stable; }
    .msg { display: flex; flex-direction: column; gap: 6px; max-width: 100%; align-items: flex-start; }
    .msg.user { align-items: flex-start; }
    .msg.ai { align-items: flex-start; }
    .msg.status { align-items: flex-start; }
    .bubble { border-radius: 12px; padding: 12px 14px; line-height: 1.6; font-size: 14px; color: var(--text); max-width: 100%; word-break: break-word; overflow-wrap: anywhere; }
    .user .bubble { background: var(--user); }
    .ai .bubble { background: var(--ai); }
    .status .bubble { background: var(--status); color: var(--muted); font-size: 13px; }
    .meta { font-size: 12px; color: var(--muted); display: none; }
    .code-block { background: #f7f7f9; color: #111827; padding: 12px; border-radius: 10px; overflow-x: auto; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; border: 1px solid #e5e7eb; }
    .code-block code { background: transparent !important; display: block; font: inherit; white-space: pre-wrap; padding: 0 !important; color: inherit; }
    .bubble > code { background: rgba(15,23,42,0.07); padding: 2px 5px; border-radius: 6px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; }
    .bubble h1, .bubble h2, .bubble h3 { margin: 0 0 6px; line-height: 1.3; }
    .bubble p { margin: 0 0 8px; }
    .bubble ul { margin: 0 0 8px 18px; padding: 0; }
    .bubble a { color: var(--accent); text-decoration: none; }
    .bubble a:hover { text-decoration: underline; }
    .cmd-details summary { cursor: pointer; color: var(--accent); }
    #form { flex-shrink: 0; padding: 0; background: transparent; border: none; box-shadow: none; display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; }
    #input-wrapper { position: relative; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 2px 8px rgba(15,23,42,0.06); }
    #attach-btn { position: absolute; left: 8px; bottom: 12px; width: 20px; height: 20px; padding: 0; background: transparent; border: none; color: #9ca3af; cursor: pointer; font-size: 18px; font-weight: 400; line-height: 20px; text-align: center; transition: color 0.15s; }
    #attach-btn:hover { color: #6b7280; }
    #attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #stop-btn { position: absolute; right: 10px; bottom: 12px; width: 24px; height: 24px; padding: 0; background: transparent; border: none; color: #ef4444; cursor: pointer; font-size: 18px; line-height: 20px; text-align: center; transition: color 0.15s, opacity 0.15s; }
    #stop-btn:hover { color: #dc2626; }
    #stop-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    #input { width: 100%; padding: 12px 46px 12px 32px; background: transparent; border: none; border-radius: 12px; font-size: 15px; min-height: 46px; max-height: 180px; resize: none; line-height: 1.5; overflow-x: hidden; overflow-y: auto; white-space: pre-wrap; word-break: break-word; outline: none; }
    #input:focus { outline: none; }
    #input-wrapper:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    #attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px; }
    #attachments:empty { display: none; }
    #console-header { position: sticky; top: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 4px 0 6px; margin: 0 -2px 4px; background: linear-gradient(var(--panel), rgba(255,255,255,0.9)); z-index: 2; }
    #clear-cache-btn { background: rgba(255,255,255,0.9); border: 1px solid #e5e7eb; color: #6b7280; cursor: pointer; font-size: 12px; padding: 6px 10px; border-radius: 999px; box-shadow: 0 2px 6px rgba(15,23,42,0.06); transition: color 0.15s, border-color 0.15s, box-shadow 0.15s; }
    #clear-cache-btn:hover { color: #ef4444; border-color: #fca5a5; box-shadow: 0 4px 10px rgba(248,113,113,0.18); }
    #clear-cache-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; background: #eef2ff; color: #1e1b4b; border-radius: 8px; font-size: 12px; }
    .chip button { border: none; background: transparent; cursor: pointer; color: #6b7280; }
    .typing-bubble { display: flex; gap: 6px; align-items: center; }
    .typing-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; animation: typing 1s infinite; opacity: 0.6; }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing { 0% { transform: translateY(0); opacity: 0.6; } 50% { transform: translateY(-2px); opacity: 1; } 100% { transform: translateY(0); opacity: 0.6; } }
    .plan-list { display: flex; flex-direction: column; gap: 6px; }
    .plan-item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--border); border-radius: 10px; background: #f9fafb; font-size: 13px; line-height: 1.5; }
    .plan-item.done { background: #ecfdf3; border-color: #bbf7d0; color: #166534; }
    .plan-marker { width: 18px; height: 18px; border-radius: 50%; background: #e0e7ff; color: #1d4ed8; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
    .plan-item.done .plan-marker { background: #22c55e; color: #fff; }
    .plan-text { flex: 1; word-break: break-word; }
    .muted { color: var(--muted); }
    #session-views { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .session-view { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .session-panel { display: flex; flex-direction: column; gap: 8px; }
    .session-current { font-size: 13px; color: var(--text); word-break: break-all; }
    .session-actions { display: flex; gap: 8px; }
    .session-actions button { flex: 1; border: 1px solid var(--border); background: #eef2ff; color: #312e81; border-radius: 8px; padding: 6px 8px; cursor: pointer; font-size: 12px; }
    .session-actions button:hover { border-color: #c7d2fe; }
    .session-dialog { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px; }
    .session-dialog.hidden { display: none; }
    .session-dialog .card { background: #fff; border: 1px solid #d6d9e0; border-radius: 12px; padding: 16px; width: 100%; max-width: 420px; box-shadow: 0 12px 30px rgba(15,23,42,0.12); display: flex; flex-direction: column; gap: 12px; }
    .session-list { max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .session-item { padding: 8px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
    .session-item:hover { border-color: #c7d2fe; background: #f8fafc; }
    .session-item .id { font-weight: 700; }
    .session-item .meta { font-size: 12px; color: var(--muted); }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); backdrop-filter: blur(18px); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
    .overlay.hidden { display: none; }
    .overlay .card { background: #fff; border: 1px solid #d6d9e0; border-radius: 12px; padding: 20px; width: 100%; max-width: 340px; box-shadow: 0 12px 30px rgba(15,23,42,0.12); display: flex; flex-direction: column; gap: 12px; }
    .overlay h2 { margin: 0; font-size: 18px; }
    .overlay p { margin: 0; color: #4b5563; font-size: 13px; }
    .overlay .row { display: flex; gap: 8px; align-items: center; }
    .overlay input { flex: 1; min-width: 0; padding: 10px 12px; font-size: 16px; border: 1px solid #d6d9e0; border-radius: 8px; }
    .overlay button { padding: 10px 14px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 16px; white-space: nowrap; }
    body.locked header, body.locked main { filter: blur(18px); pointer-events: none; user-select: none; }
    @media (max-width: 640px) {
      main { padding: 8px; gap: 8px; flex: 1; min-height: 0; overflow: hidden; }
      #sidebar { display: none; }
      #console { width: 100%; min-width: 0; flex: 1; min-height: 0; }
      #log { flex: 0 0 auto; min-height: 100px; }
      #input { min-height: 40px; font-size: 16px; }
      header { padding: 10px 12px; flex-shrink: 0; }
      header h1 { font-size: 16px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div class="header-left">
        <span id="ws-indicator" class="ws-indicator" title="WebSocket disconnected" aria-label="WebSocket disconnected"></span>
        <h1>ADS</h1>
      </div>
      <div class="tab-bar">
        <div id="session-tabs" class="tabs-scroll"></div>
        <div class="tab-icons">
          <button id="session-new" type="button" title="新建会话">＋</button>
          <button id="session-history" type="button" title="会话历史">⟳</button>
        </div>
      </div>
    </div>
  </header>
  <main>
    <aside id="sidebar">
      <h3 class="sidebar-title">Session</h3>
      <div class="session-panel">
        <div class="session-current">
          <span class="muted">当前：</span>
          <span id="session-id" class="session-pill" title="--">--</span>
          <button id="session-rename" class="session-rename" type="button" title="重命名当前会话">✎</button>
        </div>
      </div>
      <h3 class="sidebar-title">Workspace</h3>
      <div id="workspace-info" class="workspace-list"></div>
      <h3 class="sidebar-title">Modified Files</h3>
      <div id="modified-files" class="files-list"></div>
      <h3 class="sidebar-title">Plan</h3>
      <div id="plan-list" class="files-list plan-list"></div>
    </aside>
    <section id="console">
      <div id="session-views">
        <div class="session-view active" data-session="__initial__">
          <div id="log">
            <div id="console-header">
              <button id="clear-cache-btn" type="button" title="清空本地聊天缓存">清空历史</button>
            </div>
          </div>
          <form id="form">
            <div id="attachments"></div>
            <div id="input-wrapper">
              <textarea id="input" autocomplete="off" placeholder="输入文本或 /ads 命令，Enter 发送，Shift+Enter 换行"></textarea>
              <button id="attach-btn" type="button" title="添加图片">+</button>
              <button id="stop-btn" type="button" title="停止当前回复">■</button>
            </div>
            <input id="image-input" type="file" accept="image/*" multiple hidden />
            <span id="status-label" style="display:none;">已断开</span>
          </form>
        </div>
      </div>
    </section>
  </main>
  <div id="token-overlay" class="overlay">
    <div class="card">
      <h2>输入访问口令</h2>
      <p>未提供口令，无法连接</p>
      <div class="row">
        <input id="token-input" type="password" placeholder="ADS_WEB_TOKEN" autofocus />
        <button id="token-submit" type="button">连接</button>
      </div>
    </div>
  </div>
  <div id="session-dialog" class="session-dialog hidden">
    <div class="card">
      <h3 style="margin:0;">选择会话</h3>
      <div id="session-list" class="session-list"></div>
      <div class="session-actions">
        <button id="session-dialog-close" type="button">关闭</button>
      </div>
    </div>
  </div>
  <div id="alias-overlay" class="overlay hidden">
    <div class="card">
      <h2 style="margin:0;">设置会话名称</h2>
      <p style="margin:0;color:#4b5563;font-size:13px;">留空恢复默认</p>
      <div class="row">
        <input id="alias-input" type="text" placeholder="新名称" />
      </div>
      <div class="row" style="justify-content:flex-end;">
        <button id="alias-cancel" type="button" style="background:#e5e7eb;color:#111827;">取消</button>
        <button id="alias-save" type="button">保存</button>
      </div>
    </div>
  </div>
  <script>
    const sessionViewHost = document.getElementById('session-views');
    const SESSION_PLACEHOLDER = '__initial__';
    const sessionViewTemplate = sessionViewHost?.querySelector('.session-view')?.cloneNode(true);
    let logEl = document.getElementById('log');
    let inputEl = document.getElementById('input');
    let formEl = document.getElementById('form');
    const wsIndicator = document.getElementById('ws-indicator');
    const workspaceInfoEl = document.getElementById('workspace-info');
    const modifiedFilesEl = document.getElementById('modified-files');
    const planListEl = document.getElementById('plan-list');
    const tokenOverlay = document.getElementById('token-overlay');
    const tokenInput = document.getElementById('token-input');
    const tokenSubmit = document.getElementById('token-submit');
    let attachBtn = document.getElementById('attach-btn');
    let imageInput = document.getElementById('image-input');
    let attachmentsEl = document.getElementById('attachments');
    let statusLabel = document.getElementById('status-label');
    let stopBtn = document.getElementById('stop-btn');
    let clearBtn = document.getElementById('clear-cache-btn');
    const TOKEN_KEY = 'ADS_WEB_TOKEN';
    const LOG_TOOLBAR_ID = 'console-header';
    const sessionIdEl = document.getElementById('session-id');
    const sessionRenameBtn = document.getElementById('session-rename');
    const sessionNewBtn = document.getElementById('session-new');
    const sessionHistoryBtn = document.getElementById('session-history');
    const sessionTabsEl = document.getElementById('session-tabs');
    const sessionDialog = document.getElementById('session-dialog');
    const sessionListEl = document.getElementById('session-list');
    const sessionDialogClose = document.getElementById('session-dialog-close');
    const aliasOverlay = document.getElementById('alias-overlay');
    const aliasInput = document.getElementById('alias-input');
    const aliasSave = document.getElementById('alias-save');
    const aliasCancel = document.getElementById('alias-cancel');
    const SESSION_KEY = 'ADS_WEB_SESSION';
    const SESSION_HISTORY_KEY = 'ADS_WEB_SESSIONS';
    const SESSION_OPEN_KEY = 'ADS_OPEN_SESSIONS';
    const SESSION_ALIAS_KEY = 'ADS_SESSION_ALIASES';
    const PLAN_CACHE_PREFIX = 'plan-cache::';
    const WORKSPACE_CACHE_PREFIX = 'ws-cache::';
    const idleMinutes = ${IDLE_MINUTES};
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    const MAX_LOG_MESSAGES = 300;
    const MAX_SESSION_HISTORY = 15;
    const MAX_OPEN_SESSIONS = 10;
    const COMMAND_OUTPUT_MAX_LINES = 3;
    const COMMAND_OUTPUT_MAX_CHARS = 1200;
    const viewport = window.visualViewport;
    function getScopedStorage() {
      try {
        return window.sessionStorage;
      } catch {
        // 存储不可用时降级为 noop（不再使用 localStorage）
        return {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        };
      }
    }
    const scopedStorage = getScopedStorage();
    const messageCache = new Map();
    // 连接表：每个会话维护独立 WS 及其状态
    const connections = new Map();
    let streamState = null;
    let autoScroll = true;
    let activeCommandView = null;
    let activeCommandSignature = null;
    let activeCommandId = null;
    let lastCommandText = '';
    let idleTimer = null;
    let pendingImages = [];
    const typingPlaceholders = new Map();
    let typingPlaceholder = null;
    let isBusy = false;
    let planTouched = false;
    let wsIndicatorSuspended = false;
    let currentSessionId = '';
    let currentViewId = SESSION_PLACEHOLDER;
    const sessionViews = new Map();
    const sessionStates = new Map();
    let openSessions = [];
    let sessionAliases = {};
    let sessionWorkspaces = {};

    function ensureConnection(sessionId) {
      if (!connections.has(sessionId)) {
        connections.set(sessionId, {
          sessionId,
          ws: null,
          generation: 0,
          reconnectTimer: null,
          allowReconnect: true,
          pendingSends: [],
          wsErrorMessage: null,
          switchNoticeShown: false,
          suppressSwitchNotice: false,
        });
      }
      return connections.get(sessionId);
    }

    const initialView = sessionViewHost?.querySelector('.session-view');
    if (initialView) {
      initialView.dataset.session = SESSION_PLACEHOLDER;
      sessionViews.set(SESSION_PLACEHOLDER, initialView);
    }

    function defaultUiState() {
      return {
        pendingImages: [],
        autoScroll: true,
        streamState: null,
        activeCommandView: null,
        activeCommandSignature: null,
        activeCommandId: null,
        lastCommandText: '',
        isBusy: false,
        planTouched: false,
        inputDraft: '',
        sendQueue: [],
      };
    }

    function bindViewElements(container) {
      if (!container) return;
      logEl = container.querySelector('#log');
      formEl = container.querySelector('#form');
      inputEl = container.querySelector('#input');
      attachBtn = container.querySelector('#attach-btn');
      imageInput = container.querySelector('#image-input');
      attachmentsEl = container.querySelector('#attachments');
      statusLabel = container.querySelector('#status-label');
      stopBtn = container.querySelector('#stop-btn');
      clearBtn = container.querySelector('#clear-cache-btn');
    }

    function saveUiState(id) {
      if (!id) return;
      const conn = connections.get(id);
      sessionStates.set(id, {
        pendingImages: [...pendingImages],
        autoScroll,
        streamState,
        activeCommandView,
        activeCommandSignature,
        activeCommandId,
        lastCommandText,
        isBusy,
        planTouched,
        inputDraft: inputEl?.value || '',
        sendQueue: conn?.pendingSends ? [...conn.pendingSends.map((entry) => entry.type || entry.kind || entry)] : [],
      });
    }

    function restoreUiState(id) {
      const state = sessionStates.get(id) || defaultUiState();
      const conn = ensureConnection(id);
      pendingImages = [...(state.pendingImages || [])];
      autoScroll = state.autoScroll ?? true;
      streamState = state.streamState || null;
      activeCommandView = state.activeCommandView || null;
      activeCommandSignature = state.activeCommandSignature || null;
      activeCommandId = state.activeCommandId || null;
      lastCommandText = state.lastCommandText || '';
      isBusy = state.isBusy || false;
      planTouched = state.planTouched || false;
      conn.pendingSends = Array.isArray(state.sendQueue)
        ? state.sendQueue.map((kind) => ({ type: kind, payload: null }))
        : conn.pendingSends || [];
      if (inputEl) {
        inputEl.value = state.inputDraft || '';
        autoResizeInput();
      }
      renderAttachments();
      setBusy(isBusy);
    }

    function withSessionContext(sessionId, fn) {
      if (!sessionId) return fn();
      const activeId = currentSessionId;
      if (sessionId === activeId) {
        return fn();
      }
      const suppressUi = sessionId !== activeId;
      if (suppressUi) wsIndicatorSuspended = true;
      saveUiState(activeId);
      // 记住当前会话的计划，避免其他会话的计划更新覆盖 UI
      const restoreActivePlan = () => {
        if (activeId) {
          restorePlanFromCache(activeId);
        }
      };
      const view = ensureSessionView(sessionId);
      if (!view) return;
      bindViewElements(view);
      currentSessionId = sessionId;
      currentViewId = sessionId;
      typingPlaceholder = typingPlaceholders.get(sessionId) || null;
      restoreUiState(sessionId);
      const result = fn();
      saveUiState(sessionId);
      const activeView = ensureSessionView(activeId);
      if (activeView) {
        bindViewElements(activeView);
        currentSessionId = activeId;
        currentViewId = activeId;
        typingPlaceholder = typingPlaceholders.get(activeId) || null;
        restoreUiState(activeId);
        restoreActivePlan();
      }
      if (suppressUi) wsIndicatorSuspended = false;
      return result;
    }

    function handleLogScroll() {
      if (!logEl) return;
      autoScroll = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
      const state = sessionStates.get(currentSessionId);
      if (state) {
        state.autoScroll = autoScroll;
      }
    }

    function handleInputKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (formEl?.requestSubmit) {
          formEl.requestSubmit();
        } else if (formEl) {
          formEl.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
      resetIdleTimer();
    }

    function handleDragOver(e) {
      e.preventDefault();
    }

    function handleDrop(e) {
      e.preventDefault();
      addImagesFromFiles(e.dataTransfer?.files || []);
    }

    function handlePaste(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImagesFromFiles(imageFiles);
      }
    }

    function persistDraft() {
      const state = sessionStates.get(currentSessionId) || defaultUiState();
      state.inputDraft = inputEl?.value || '';
      sessionStates.set(currentSessionId, state);
    }

    function handleStop() {
      const conn = ensureConnection(currentSessionId);
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN || !isBusy) return;
      conn.ws.send(JSON.stringify({ type: 'interrupt' }));
      appendStatus('⛔ 已请求停止，输出可能不完整');
      setBusy(false);
    }

    function handleSubmit(e) {
      e.preventDefault();
      const text = inputEl?.value?.trim() || '';
      const hasImages = pendingImages.length > 0;
      const isCommand = text.startsWith('/');
      const cmdId = isCommand ? Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : null;
      startNewTurn(!isCommand);
      const type = isCommand ? 'command' : 'prompt';
      const payload = isCommand
        ? text
        : {
            text,
            images: hasImages ? pendingImages : undefined,
          };
      if (!text && !hasImages) return;
      const conn = ensureConnection(currentSessionId);
      if (!conn.ws || conn.ws.readyState === WebSocket.CLOSING || conn.ws.readyState === WebSocket.CLOSED) {
        connect(currentSessionId);
      }
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        appendStatus('当前会话未连接，已尝试重连');
        conn.pendingSends.push({ type, payload });
        return;
      }
      autoScroll = true;
      conn.ws.send(JSON.stringify({ type, payload }));
      conn.pendingSends.push({ type, payload });
      setBusy(true);
      if (isCommand) {
        lastCommandText = text;
        renderCommandView({ id: cmdId, commandText: text, status: 'in_progress' });
      } else {
        lastCommandText = '';
        activeCommandView = null;
        activeCommandSignature = null;
        activeCommandId = null;
        appendMessage('user', text || '(图片)');
        appendTypingPlaceholder();
        streamState = null;
      }
      if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = '44px';
      }
      clearAttachments();
      inputEl?.focus();
      resetIdleTimer();
      recalcLogHeight();
    }

    function handleClearLog() {
      clearLogMessages();
    }

    function wireSessionView(container) {
      if (!container || container.dataset.wired) return;
      container.dataset.wired = '1';
      const logNode = container.querySelector('#log');
      const inputNode = container.querySelector('#input');
      const formNode = container.querySelector('#form');
      const attachNode = container.querySelector('#attach-btn');
      const imageNode = container.querySelector('#image-input');
      const stopNode = container.querySelector('#stop-btn');
      const clearNode = container.querySelector('#clear-cache-btn');

      logNode?.addEventListener('scroll', handleLogScroll);
      inputNode?.addEventListener('keydown', handleInputKeydown);
      inputNode?.addEventListener('input', () => {
        autoResizeInput();
        persistDraft();
      });
      inputNode?.addEventListener('focus', recalcLogHeight);
      inputNode?.addEventListener('blur', recalcLogHeight);
      formNode?.addEventListener('dragover', handleDragOver);
      formNode?.addEventListener('drop', handleDrop);
      inputNode?.addEventListener('paste', handlePaste);
      formNode?.addEventListener('submit', handleSubmit);
      attachNode?.addEventListener('click', () => imageNode?.click());
      imageNode?.addEventListener('change', () => addImagesFromFiles(imageNode.files));
      stopNode?.addEventListener('click', handleStop);
      if (stopNode) stopNode.disabled = true;
      clearNode?.addEventListener('click', handleClearLog);
    }

    function ensureSessionView(id) {
      if (!id) return null;
      if (sessionViews.has(id)) {
        return sessionViews.get(id);
      }
      if (sessionViews.has(SESSION_PLACEHOLDER)) {
        const placeholderView = sessionViews.get(SESSION_PLACEHOLDER);
        sessionViews.delete(SESSION_PLACEHOLDER);
        if (placeholderView) {
          placeholderView.dataset.session = id;
          sessionViews.set(id, placeholderView);
          return placeholderView;
        }
      }
      if (!sessionViewTemplate) return null;
      const clone = sessionViewTemplate.cloneNode(true);
      clone.dataset.session = id;
      const cloneLog = clone.querySelector('#log');
      if (cloneLog) {
        Array.from(cloneLog.children).forEach((child) => {
          if (!isLogToolbar(child)) {
            child.remove();
          }
        });
      }
      const cloneInput = clone.querySelector('#input');
      if (cloneInput) {
        cloneInput.value = '';
      }
      const cloneAttachments = clone.querySelector('#attachments');
      if (cloneAttachments) {
        cloneAttachments.innerHTML = '';
      }
      wireSessionView(clone);
      sessionViews.set(id, clone);
      return clone;
    }

    function sessionHasContent(container) {
      const logNode = container?.querySelector('#log');
      if (!logNode) return false;
      const validChildren = Array.from(logNode.children).filter((child) => !isLogToolbar(child));
      return validChildren.length > 0;
    }

    function restoreSessionView(sessionId) {
      const view = ensureSessionView(sessionId);
      if (!view || !sessionViewHost) return false;
      saveUiState(currentSessionId);
      sessionViewHost.innerHTML = '';
      sessionViewHost.appendChild(view);
      currentViewId = sessionId;
      bindViewElements(view);
      restoreUiState(sessionId);
      typingPlaceholder = typingPlaceholders.get(sessionId) || null;
      autoResizeInput();
      recalcLogHeight();
      autoScrollIfNeeded();
      return sessionHasContent(view);
    }

    function stashSessionView() {
      if (!currentSessionId) return;
      saveUiState(currentSessionId);
      const view = sessionViews.get(currentSessionId);
      if (view && sessionViewHost?.contains(view)) {
        sessionViewHost.removeChild(view);
      }
    }

    if (initialView) {
      wireSessionView(initialView);
      bindViewElements(initialView);
      restoreUiState(SESSION_PLACEHOLDER);
    }

    function setBusy(busy) {
      isBusy = !!busy;
      if (stopBtn) {
        const conn = ensureConnection(currentSessionId);
        const canUse = isBusy && conn.ws && conn.ws.readyState === WebSocket.OPEN;
        stopBtn.disabled = !canUse;
      }
    }
    function applyVh() {
      const vh = viewport ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--vh', vh + 'px');
      recalcLogHeight();
    }
    applyVh();
    sessionAliases = loadSessionAliases();
    sessionWorkspaces = loadSessionWorkspaces();
    renderPlanStatus('暂无计划');
    renderSessionList();
    openSessions = loadOpenSessions();
    renderSessionTabs();
    window.addEventListener('resize', applyVh);
    if (viewport) {
      viewport.addEventListener('resize', applyVh);
      viewport.addEventListener('scroll', () => window.scrollTo(0, 0));
    }

    function recalcLogHeight() {
      if (!logEl) return;
      const headerEl = document.querySelector('header');
      const mainEl = document.querySelector('main');
      const headerH = headerEl ? headerEl.getBoundingClientRect().height : 0;
      const formH = formEl ? formEl.getBoundingClientRect().height : 0;
      const mainStyle = mainEl ? window.getComputedStyle(mainEl) : null;
      const paddingY =
        (mainStyle ? Number.parseFloat(mainStyle.paddingTop || '0') : 0) +
        (mainStyle ? Number.parseFloat(mainStyle.paddingBottom || '0') : 0);
      const vh = viewport ? viewport.height : window.innerHeight;
      const gap = 12;
      const available = vh - headerH - formH - gap - paddingY;
      logEl.style.height = Math.max(100, available) + 'px';
      logEl.style.maxHeight = Math.max(100, available) + 'px';
      logEl.scrollTop = logEl.scrollHeight;
    }
    setTimeout(recalcLogHeight, 100);

    function isLogToolbar(node) {
      return node?.id === LOG_TOOLBAR_ID;
    }

    function clearLogMessages() {
      if (!logEl) return;
      Array.from(logEl.children).forEach((child) => {
        if (!isLogToolbar(child)) {
          child.remove();
        }
      });
      // 清空当前会话的内存缓存
      saveCache([], currentSessionId);
      savePlanCache([], currentSessionId);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/[&<>\"']/g, (ch) => {
        switch (ch) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#39;';
          default: return ch;
        }
      });
    }

    function renderMarkdown(md) {
      if (!md) return '';
      const segments = [];
      const normalized = md.replace(/\\r\\n/g, '\\n');
      const BT = String.fromCharCode(96);
      const fence = new RegExp(BT + BT + BT + "(\\\\w+)?\\\\n?([\\\\s\\\\S]*?)" + BT + BT + BT, "g");
      let last = 0;
      let match;
      while ((match = fence.exec(normalized)) !== null) {
        if (match.index > last) {
          segments.push({ type: 'text', content: normalized.slice(last, match.index) });
        }
        segments.push({ type: 'code', lang: match[1], content: match[2] });
        last = fence.lastIndex;
      }
      if (last < normalized.length) {
        segments.push({ type: 'text', content: normalized.slice(last) });
      }

      const inlineCode = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");

      const renderInline = (text) =>
        text
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(inlineCode, '<code>$1</code>')
          .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

      const renderParagraph = (block) => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        const lines = trimmed.split('\\n');
        const isList = lines.every((l) => /^[-*]\\s+/.test(l));
        if (isList) {
          const items = lines
            .map((l) => l.replace(/^[-*]\\s+/, ''))
            .map((txt) => renderInline(escapeHtml(txt)));
          return '<ul>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>';
        }
        const heading = trimmed.match(/^(#{1,3})\\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          return '<h' + level + '>' + renderInline(escapeHtml(heading[2])) + '</h' + level + '>';
        }
        return '<p>' + renderInline(escapeHtml(trimmed)) + '</p>';
      };

      const renderTextBlock = (text) => {
        return text
          .split(/\\n\\s*\\n/)
          .map((block) => renderParagraph(block))
          .join('');
      };

      return segments
        .map((seg) => {
          if (seg.type === 'code') {
            const code = escapeHtml(seg.content.replace(/\\n+$/, ''));
            const langClass = seg.lang ? ' class="language-' + escapeHtml(seg.lang) + '"' : '';
            return '<pre class="code-block"><code' + langClass + '>' + code + '</code></pre>';
          }
          return renderTextBlock(seg.content);
        })
        .join('');
    }

    function createCodeBlockElement(content, language) {
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      const code = document.createElement('code');
      if (language) {
        code.classList.add('language-' + language);
      }
      code.textContent = content || '';
      pre.appendChild(code);
      return pre;
    }

    function autoScrollIfNeeded() {
      if (!autoScroll) return;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function pruneLog() {
      if (!logEl) return;
      const entries = Array.from(logEl.children).filter((child) => !isLogToolbar(child));
      while (entries.length > MAX_LOG_MESSAGES) {
        const first = entries.shift();
        if (!first) break;
        if (first.isConnected) {
          first.remove();
        }
      }
      const currentTyping = typingPlaceholders.get(currentSessionId);
      if (currentTyping?.wrapper && !currentTyping.wrapper.isConnected) {
        typingPlaceholders.delete(currentSessionId);
        typingPlaceholder = null;
      }
      if (activeCommandView && !activeCommandView.wrapper?.isConnected) {
        activeCommandView = null;
        activeCommandSignature = null;
        activeCommandId = null;
      }
    }

    function setLocked(locked) {
      document.body.classList.toggle('locked', !!locked);
    }

    function scheduleReconnect(sessionId) {
      const conn = ensureConnection(sessionId);
      if (!conn.allowReconnect) return;
      if (!tokenOverlay.classList.contains('hidden')) return;
      if (conn.reconnectTimer) return;
      conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        connect(sessionId);
      }, 1500);
    }

    logEl.addEventListener('scroll', () => {
      const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
      autoScroll = nearBottom;
    });

    function appendMessage(role, text, options = {}) {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg ' + role + (options.status ? ' status' : '');
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (options.markdown) {
        bubble.innerHTML = renderMarkdown(text);
      } else if (options.html) {
        bubble.innerHTML = text;
      } else {
        bubble.textContent = text;
      }
      wrapper.appendChild(bubble);
      logEl.appendChild(wrapper);
      pruneLog();
      autoScrollIfNeeded();
      if (!options.skipCache) {
        recordCache(role, text, options.status ? 'status' : undefined);
      }
      return { wrapper, bubble };
    }

    function appendStatus(text) {
      return appendMessage('status', text, { status: true });
    }

    function clearTypingPlaceholder(sessionId = currentSessionId) {
      const currentTyping = typingPlaceholders.get(sessionId) || typingPlaceholder;
      if (currentTyping?.wrapper?.isConnected) {
        currentTyping.wrapper.remove();
      }
      typingPlaceholders.delete(sessionId);
      if (sessionId === currentSessionId) {
        typingPlaceholder = null;
      }
    }

    function appendTypingPlaceholder() {
      clearTypingPlaceholder();
      const wrapper = document.createElement('div');
      wrapper.className = 'msg ai';
      const bubble = document.createElement('div');
      bubble.className = 'bubble typing-bubble';
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'typing-dot';
        bubble.appendChild(dot);
      }
      wrapper.appendChild(bubble);
      logEl.appendChild(wrapper);
      pruneLog();
      autoScrollIfNeeded();
      typingPlaceholder = { wrapper, bubble };
      typingPlaceholders.set(currentSessionId, typingPlaceholder);
      return typingPlaceholder;
    }

    function startNewTurn(clearPlan) {
      // 新回合不再清理命令气泡，保留上一条命令输出
      lastCommandText = '';
      if (clearPlan) {
        planTouched = false;
        renderPlanStatus('生成计划中...');
        savePlanCache([], currentSessionId);
      }
    }

    function resetCommandView(removeWrapper) {
      if (removeWrapper && activeCommandView?.wrapper?.isConnected) {
        activeCommandView.wrapper.remove();
      }
      activeCommandView = null;
      activeCommandSignature = null;
      activeCommandId = null;
    }

    function buildCommandHeading(status, exitCode) {
      const exitText = exitCode === undefined || exitCode === null ? '' : ' (exit ' + exitCode + ')';
      if (status === 'failed') {
        return '命令失败' + exitText;
      }
      if (status === 'completed') {
        return '命令完成' + exitText;
      }
      return '命令执行中';
    }

    function renderCommandView(options = {}) {
      const cmdId = options.id || null;
      // 同一次对话内的多条命令复用同一个气泡（覆盖显示）
      // 新对话开始时在 form submit 处已重置指针，会创建新气泡
      if (cmdId) {
        activeCommandId = cmdId;
      }
      const commandText = options.commandText || options.detail || '';
      const status = options.status || 'in_progress';
      const exitCode = options.exitCode;
      const heading = options.title || buildCommandHeading(status, exitCode);
      const output = typeof options.output === 'string' ? options.output : '';
      const { snippet, truncated } = summarizeCommandOutput(output);
      const signature = [commandText, status, snippet, heading].join('||');
      if (signature === activeCommandSignature && activeCommandView?.wrapper?.isConnected) {
        return;
      }
      activeCommandSignature = signature;
      clearTypingPlaceholder();
      streamState = null;
      const message = activeCommandView?.wrapper?.isConnected ? activeCommandView : appendMessage('status', '', { status: true });
      activeCommandView = message;
      const bubble = message.bubble;
      bubble.innerHTML = '';

      if (commandText) {
        const cmdLabel = document.createElement('div');
        cmdLabel.textContent = '命令';
        cmdLabel.style.color = 'var(--muted)';
        cmdLabel.style.fontSize = '12px';
        cmdLabel.style.marginTop = '6px';
        bubble.appendChild(cmdLabel);

        const cmdBlock = createCodeBlockElement(commandText, 'bash');
        bubble.appendChild(cmdBlock);
      }

      const outBlock = createCodeBlockElement(snippet || '(无输出)', 'bash');
      outBlock.style.marginTop = '6px';
      bubble.appendChild(outBlock);

      const headingEl = document.createElement('div');
      headingEl.textContent = heading;
      headingEl.style.fontWeight = '600';
      headingEl.style.marginTop = '8px';
      bubble.appendChild(headingEl);
      autoScrollIfNeeded();
      if (status === 'in_progress') {
        setBusy(true);
      } else {
        setBusy(false);
      }
    }

    function setWsState(state, sessionId) {
      if (wsIndicatorSuspended) return;
      if (sessionId && sessionId !== currentSessionId) {
        return;
      }
      if (wsIndicator) {
        wsIndicator.classList.remove('connected', 'connecting');
        if (state === 'connected') {
          wsIndicator.classList.add('connected');
        } else if (state === 'connecting') {
          wsIndicator.classList.add('connecting');
        }
      }
      const label =
        state === 'connected'
          ? 'WebSocket connected'
          : state === 'connecting'
          ? 'WebSocket connecting'
          : 'WebSocket disconnected';
      if (wsIndicator) {
        wsIndicator.setAttribute('title', label);
        wsIndicator.setAttribute('aria-label', label);
      }
      if (statusLabel) {
        statusLabel.textContent =
          state === 'connected' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开';
      }
      const enableInput = state === 'connected';
      if (inputEl) inputEl.disabled = !enableInput;
      if (attachBtn) attachBtn.disabled = !enableInput;
      if (!enableInput) {
        setBusy(false);
      } else {
        setBusy(isBusy);
      }
    }

    function getTokenKey() {
      const token = sessionStorage.getItem(TOKEN_KEY) || '';
      return token || 'default';
    }

    function resolveSessionIdForCache(sessionId) {
      if (sessionId) return sessionId;
      if (currentSessionId) return currentSessionId;
      const stored = loadSession();
      return stored || 'default';
    }

    function cacheKey(sessionId) {
      return 'chat-cache::' + getTokenKey() + '::' + resolveSessionIdForCache(sessionId);
    }

    function loadCache(sessionId) {
      const key = cacheKey(sessionId);
      const memo = messageCache.get(key);
      if (Array.isArray(memo)) return [...memo];
      try {
        const raw = scopedStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveCache(items, sessionId) {
      const key = cacheKey(sessionId);
      const trimmed = items.slice(-MAX_LOG_MESSAGES);
      messageCache.set(key, trimmed);
      try {
        scopedStorage.setItem(key, JSON.stringify(trimmed));
      } catch {
        /* ignore */
      }
    }

    function recordCache(role, text, kind) {
      const items = loadCache();
      items.push({ r: role, t: text, k: kind });
      if (items.length > MAX_LOG_MESSAGES) {
        items.shift();
      }
      saveCache(items);
    }

    function planCacheKey(sessionId) {
      return PLAN_CACHE_PREFIX + getTokenKey() + '::' + resolveSessionIdForCache(sessionId);
    }

    function loadPlanCache(sessionId) {
      try {
        const raw = scopedStorage.getItem(planCacheKey(sessionId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function savePlanCache(items, sessionId) {
      try {
        const key = planCacheKey(sessionId);
        if (!items || items.length === 0) {
          scopedStorage.removeItem(key);
          return;
        }
        scopedStorage.setItem(key, JSON.stringify(items));
      } catch {
        /* ignore */
      }
    }

    function restorePlanFromCache(sessionId) {
      const planItems = loadPlanCache(sessionId);
      if (planItems && planItems.length > 0) {
        renderPlan(planItems);
        return;
      }
      planTouched = false;
      renderPlanStatus('暂无计划');
    }

    function aliasStorageKey(tokenKey = getTokenKey()) {
      return SESSION_ALIAS_KEY + '::' + tokenKey;
    }

    function workspaceStorageKey(tokenKey = getTokenKey()) {
      return WORKSPACE_CACHE_PREFIX + tokenKey;
    }

    function loadSessionAliases() {
      const merged = {};
      const loadOne = (key) => {
        try {
          const raw = scopedStorage.getItem(key);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && k) {
                merged[k] = v;
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      loadOne(aliasStorageKey()); // token scoped
      loadOne(aliasStorageKey('global')); // fallback to last-saved aliases without token约束
      return merged;
    }

    function loadSessionWorkspaces() {
      const merged = {};
      const loadOne = (key) => {
        try {
          const raw = scopedStorage.getItem(key);
          if (!raw) return;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && k) {
                merged[k] = v;
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      loadOne(workspaceStorageKey());
      loadOne(workspaceStorageKey('global'));
      return merged;
    }

    function saveSessionAliases(map = sessionAliases) {
      try {
        const payload = JSON.stringify(map);
        scopedStorage.setItem(aliasStorageKey(), payload);
        scopedStorage.setItem(aliasStorageKey('global'), payload);
      } catch {
        /* ignore */
      }
    }

    function saveSessionWorkspaces(map = sessionWorkspaces) {
      try {
        const payload = JSON.stringify(map);
        scopedStorage.setItem(workspaceStorageKey(), payload);
        scopedStorage.setItem(workspaceStorageKey('global'), payload);
      } catch {
        /* ignore */
      }
    }

    function getSessionAlias(id) {
      if (!id) return '';
      return sessionAliases[id] || '';
    }

    function setSessionAlias(id, name) {
      if (!id) return;
      const trimmed = (name || '').trim();
      if (trimmed) {
        sessionAliases[id] = trimmed;
      } else {
        delete sessionAliases[id];
      }
      saveSessionAliases();
      renderSessionTabs();
      renderSessionList();
      updateSessionLabel(currentSessionId);
    }

    function getWorkspaceForSession(id) {
      if (id && sessionWorkspaces[id]) {
        return sessionWorkspaces[id];
      }
      return sessionWorkspaces.__last || '';
    }

    function setWorkspaceForSession(id, path) {
      if (!path) return;
      if (id) {
        sessionWorkspaces[id] = path;
      }
      sessionWorkspaces.__last = path; // 记录 token 下的最近工作目录，防止 sessionId 变化导致丢失
      saveSessionWorkspaces();
    }

    function maybeRestoreWorkspace(sessionId, serverPath, conn) {
      const cached = getWorkspaceForSession(sessionId);
      if (!cached || cached === serverPath) return;
      const payload = { type: 'command', payload: '/ads.cd ' + cached };
      const targetConn = conn || ensureConnection(sessionId);
      targetConn.pendingSends = targetConn.pendingSends || [];
      // 如果已连接，立即发送；否则排队
      if (targetConn.ws && targetConn.ws.readyState === WebSocket.OPEN) {
        try {
          targetConn.ws.send(JSON.stringify(payload));
        } catch {
          targetConn.pendingSends.push(payload);
        }
      } else {
        targetConn.pendingSends.push(payload);
      }
    }

    function resolveSessionLabel(id) {
      if (!id) return '--';
      const alias = getSessionAlias(id);
      return alias || id;
    }

    function resolveSessionTitle(id) {
      if (!id) return '--';
      const alias = getSessionAlias(id);
      if (alias && alias !== id) {
        return alias + ' (' + id + ')';
      }
      return id;
    }

    function loadSessionHistory() {
      try {
        const raw = scopedStorage.getItem(SESSION_HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveSessionHistory(list) {
      try {
        scopedStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_SESSION_HISTORY)));
      } catch {
        /* ignore */
      }
    }

    function loadOpenSessions() {
      try {
        const raw = scopedStorage.getItem(SESSION_OPEN_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.trim()) : [];
      } catch {
        return [];
      }
    }

    function saveOpenSessions(list) {
      try {
        scopedStorage.setItem(SESSION_OPEN_KEY, JSON.stringify(list.slice(0, MAX_OPEN_SESSIONS)));
      } catch {
        /* ignore */
      }
    }

    function rememberSession(id) {
      if (!id) return;
      const list = loadSessionHistory().filter((entry) => entry?.id !== id);
      list.unshift({ id, ts: Date.now() });
      saveSessionHistory(list);
      renderSessionList();
    }

    function ensureOpenSession(id) {
      if (!id) return;
      const exists = openSessions.includes(id);
      if (!exists) {
        openSessions.push(id); // 新会话追加到末尾，保持 tab 顺序稳定
        if (openSessions.length > MAX_OPEN_SESSIONS) {
          // 如果超过上限，移除最旧的会话（队列前端）
          openSessions = openSessions.slice(-MAX_OPEN_SESSIONS);
        }
      }
      saveOpenSessions(openSessions);
      renderSessionTabs();
    }

    function removeOpenSession(id) {
      openSessions = openSessions.filter((entry) => entry && entry !== id);
      if (openSessions.length === 0 && currentSessionId) {
        openSessions = [currentSessionId];
      }
      saveOpenSessions(openSessions);
      renderSessionTabs();
    }

    function renderSessionList() {
      if (!sessionListEl) return;
      const list = loadSessionHistory();
      sessionListEl.innerHTML = '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = '暂无会话记录';
        sessionListEl.appendChild(empty);
        return;
      }
      list.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'session-item';
        const idEl = document.createElement('span');
        idEl.className = 'id';
        const alias = getSessionAlias(item.id);
        idEl.textContent = alias || item.id;
        idEl.title = resolveSessionTitle(item.id);
        const meta = document.createElement('span');
        meta.className = 'meta';
        const ts = item.ts ? new Date(item.ts) : null;
        const tsText = ts ? ts.toLocaleString() : '';
        meta.textContent = alias ? [item.id, tsText].filter(Boolean).join(' · ') : tsText;
        row.appendChild(idEl);
        row.appendChild(meta);
        row.addEventListener('click', () => {
          if (sessionDialog) {
            sessionDialog.classList.add('hidden');
          }
          switchSession(item.id);
        });
        sessionListEl.appendChild(row);
      });
    }

    function renderSessionTabs() {
      if (!sessionTabsEl) return;
      sessionTabsEl.innerHTML = '';
      if (!openSessions.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.textContent = '暂无会话';
        sessionTabsEl.appendChild(empty);
        return;
      }
      openSessions.forEach((id) => {
        const tab = document.createElement('div');
        tab.className = 'session-tab' + (id === currentSessionId ? ' active' : '');
        tab.title = resolveSessionTitle(id);
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = resolveSessionLabel(id);
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeSessionTab(id);
        });
        tab.appendChild(label);
        tab.appendChild(closeBtn);
        tab.addEventListener('click', () => {
          if (id === currentSessionId) return;
          switchSession(id);
        });
        sessionTabsEl.appendChild(tab);
      });
    }

    function renderHistory(items) {
      if (!Array.isArray(items) || items.length === 0) {
        return;
      }
      clearLogMessages();
      items.forEach((item) => {
        const role = item.role || item.r || 'status';
        const text = item.text || item.t || '';
        const kind = item.kind || item.k;
        const isStatus = role === 'status' || kind === 'status' || kind === 'plan' || kind === 'error';
        appendMessage(role === 'status' ? 'status' : role, text, { markdown: false, status: isStatus, skipCache: true });
      });
      autoScrollIfNeeded();
    }

    function restoreFromCache(sessionId) {
      const cached = loadCache(sessionId);
      if (!cached || cached.length === 0) return;
      clearLogMessages();
      cached.forEach((item) => {
        const role = item.r || 'status';
        const text = item.t || '';
        const kind = item.k;
        const isStatus = role === 'status' || kind === 'status';
        appendMessage(role, text, { markdown: false, status: isStatus, skipCache: true });
      });
      pruneLog();
      autoScrollIfNeeded();
    }

    function resetIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        const reason = '空闲超过 ' + idleMinutes + ' 分钟，已锁定';
        sessionStorage.removeItem(TOKEN_KEY);
        connections.forEach((conn) => {
          if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.close(4400, "idle timeout");
          }
        });
        tokenOverlay.classList.remove('hidden');
        tokenInput.value = '';
        setLocked(true);
        appendMessage('ai', reason, { status: true });
        setWsState('disconnected');
      }, idleMinutes * 60 * 1000);
    }

    function updateSessionLabel(id) {
      currentSessionId = id || '';
      if (sessionIdEl) {
        sessionIdEl.textContent = resolveSessionLabel(currentSessionId);
        sessionIdEl.title = resolveSessionTitle(currentSessionId);
      }
      rememberSession(currentSessionId);
      ensureOpenSession(currentSessionId);
    }

    function saveSession(id) {
      try {
        sessionStorage.setItem(SESSION_KEY, id);
      } catch {
        /* ignore */
      }
    }

    function loadSession() {
      try {
        return sessionStorage.getItem(SESSION_KEY) || '';
      } catch {
        return '';
      }
    }

    function clearSession() {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        /* ignore */
      }
    }

    function newSessionId() {
      return Math.random().toString(36).slice(2, 8);
    }

    function switchSession(targetId, skipStash) {
      if (!targetId || targetId === currentSessionId) return;
      if (!skipStash) {
        stashSessionView();
      }
      saveSession(targetId);
      updateSessionLabel(targetId);
      restorePlanFromCache(targetId);
      const restored = restoreSessionView(targetId);
      if (!restored) {
        restoreFromCache(targetId);
        if (inputEl) {
          inputEl.value = '';
          autoResizeInput();
        }
      }
      setBusy(isBusy);
      connect(targetId);
    }

    function closeSessionTab(id) {
      const wasActive = id === currentSessionId;
      sessionViews.delete(id);
      sessionStates.delete(id);
      removeOpenSession(id);
      if (wasActive) {
        const fallback = openSessions[0] || newSessionId();
        switchSession(fallback, true);
      } else {
        renderSessionTabs();
      }
    }

    function handleWsMessageForSession(sessionId, conn, ev) {
      withSessionContext(sessionId, () => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'result') {
            handleResult(msg, conn);
          } else if (msg.type === 'delta') {
            handleDelta(msg.delta || '');
          } else if (msg.type === 'command') {
            const cmd = msg.command || {};
            renderCommandView({
              id: cmd.id,
              commandText: cmd.command || msg.detail || '',
              detail: msg.detail,
              status: cmd.status || 'in_progress',
              output: cmd.aggregated_output || '',
              exitCode: cmd.exit_code,
            });
            return;
          } else if (msg.type === 'history') {
            renderHistory(msg.items || []);
            return;
          } else if (msg.type === 'plan') {
            renderPlan(msg.items || []);
            return;
          } else if (msg.type === 'welcome') {
            setWsState('connected', sessionId);
            if (msg.sessionId) {
              updateSessionLabel(msg.sessionId);
              saveSession(msg.sessionId);
            }
            if (msg.workspace) {
              if (msg.workspace.path) {
                setWorkspaceForSession(sessionId, msg.workspace.path);
                maybeRestoreWorkspace(sessionId, msg.workspace.path, conn);
              }
              renderWorkspaceInfo(msg.workspace);
            }
          } else if (msg.type === 'workspace') {
            if (msg.data?.path) {
              setWorkspaceForSession(sessionId, msg.data.path);
            }
            renderWorkspaceInfo(msg.data);
          } else if (msg.type === 'error') {
            clearTypingPlaceholder();
            streamState = null;
            const queued = conn.pendingSends.shift() || { type: 'prompt' };
            const failedKind = queued.type || queued;
            if (failedKind === 'command') {
              renderCommandView({
                commandText: lastCommandText || '',
                status: 'failed',
                output: msg.message || '',
                title: '命令失败',
              });
              appendMessage('ai', msg.message || '错误', { status: true });
            } else {
              appendMessage('ai', msg.message || '错误', { status: true });
            }
            setBusy(false);
            return;
          } else {
            appendMessage('ai', ev.data, { status: true });
          }
        } catch {
          appendMessage('ai', ev.data, { status: true });
        }
      });
    }

    function connect(sessionIdOverride) {
      const activeId = currentSessionId;
      const sessionIdToUse = sessionIdOverride || activeId || loadSession() || newSessionId();
      const conn = ensureConnection(sessionIdToUse);
      saveSession(sessionIdToUse);
      if (!activeId) {
        updateSessionLabel(sessionIdToUse);
      }
      if (sessionIdToUse === activeId || !activeId) {
        restoreSessionView(sessionIdToUse);
        restorePlanFromCache(sessionIdToUse);
      } else {
        ensureSessionView(sessionIdToUse);
      }
      const token = sessionStorage.getItem(TOKEN_KEY) || '';
      if (!token) {
        tokenOverlay.classList.remove('hidden');
        tokenInput.focus();
        setLocked(true);
        return null;
      }
      tokenOverlay.classList.add('hidden');
      setLocked(false);
      if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) {
        return conn.ws;
      }
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname;
      conn.generation += 1;
      const socketId = conn.generation;
      conn.pendingSends = conn.pendingSends || [];
      withSessionContext(sessionIdToUse, () => {
        streamState = null;
        clearTypingPlaceholder();
        resetCommandView(false);
        setWsState('connecting', sessionIdToUse);
      });
      conn.ws = new WebSocket(url, ['ads-token', token, 'ads-session', sessionIdToUse]);
      conn.ws.onopen = () => {
        if (socketId !== conn.generation) return;
        if (conn.reconnectTimer) {
          clearTimeout(conn.reconnectTimer);
          conn.reconnectTimer = null;
        }
        if (conn.wsErrorMessage?.wrapper?.isConnected) {
          conn.wsErrorMessage.wrapper.remove();
          conn.wsErrorMessage = null;
        }
        conn.switchNoticeShown = false;
        setWsState('connected', sessionIdToUse);
        resetIdleTimer();
        setLocked(false);
        // flush pending sends
        const pending = [...conn.pendingSends];
        conn.pendingSends = [];
        pending.forEach(({ type, payload }) => {
          try {
            conn.ws?.send(JSON.stringify({ type, payload }));
          } catch {
            /* ignore */
          }
        });
      };
      conn.ws.onmessage = (ev) => {
        if (socketId !== conn.generation) return;
        handleWsMessageForSession(sessionIdToUse, conn, ev);
      };
      conn.ws.onclose = (ev) => {
        if (socketId !== conn.generation) return;
        withSessionContext(sessionIdToUse, () => {
          setWsState('disconnected', sessionIdToUse);
          setBusy(false);
          clearTypingPlaceholder(sessionIdToUse);
          streamState = null;
        });
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (ev.code === 4401) {
          sessionStorage.removeItem(TOKEN_KEY);
          tokenOverlay.classList.remove('hidden');
          tokenInput.value = '';
          setLocked(true);
          withSessionContext(sessionIdToUse, () => {
            appendMessage('ai', '口令无效或已过期，请重新输入', { status: true });
          });
          clearSession();
          conn.allowReconnect = false;
        } else if (ev.code === 4409) {
          if (!conn.suppressSwitchNotice && !conn.switchNoticeShown) {
            withSessionContext(sessionIdToUse, () => {
              appendMessage('ai', '已有新连接，当前会话被替换或已达上限', { status: true, skipCache: true });
            });
            conn.switchNoticeShown = true;
          }
          conn.suppressSwitchNotice = false;
          conn.allowReconnect = false;
        } else {
          conn.allowReconnect = true;
        }
        renderWorkspaceInfo(null);
        scheduleReconnect(sessionIdToUse);
      };
      conn.ws.onerror = (err) => {
        if (socketId !== conn.generation) return;
        withSessionContext(sessionIdToUse, () => {
          setWsState('disconnected', sessionIdToUse);
          setBusy(false);
          clearTypingPlaceholder(sessionIdToUse);
          streamState = null;
          const message =
            err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : 'WebSocket error';
          if (!conn.wsErrorMessage || !conn.wsErrorMessage.wrapper?.isConnected) {
            conn.wsErrorMessage = appendMessage('ai', 'WS error: ' + message, { status: true, skipCache: true });
          }
        });
        scheduleReconnect(sessionIdToUse);
      };
      return conn.ws;
    }

    // 自动调整输入框高度，最多6行
    function autoResizeInput() {
      if (!inputEl) return;
      inputEl.style.height = 'auto';
      const lineHeight = 24; // 约等于 font-size * line-height
      const minHeight = 44;
      const maxHeight = lineHeight * 6 + 24; // 6行 + padding
      const scrollHeight = inputEl.scrollHeight;
      const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
      inputEl.style.height = newHeight + 'px';
      recalcLogHeight();
    }

    function ensureStream() {
      if (!streamState) {
        clearTypingPlaceholder();
        streamState = {
          buffer: '',
          message: appendMessage('ai', '', { markdown: false, skipCache: true }),
        };
      }
      return streamState;
    }

    function handleDelta(delta) {
      const stream = ensureStream();
      stream.buffer += delta;
      stream.message.bubble.textContent = stream.buffer;
      autoScrollIfNeeded();
      resetIdleTimer();
    }

    function summarizeCommandOutput(rawOutput) {
      const text = (typeof rawOutput === 'string' ? rawOutput : '').trim();
      if (!text) {
        return { snippet: '(无输出)', truncated: false, full: '' };
      }
      const lines = text.split(/\\r?\\n/);
      const kept = lines.slice(0, COMMAND_OUTPUT_MAX_LINES);
      let truncated = lines.length > COMMAND_OUTPUT_MAX_LINES;
      let snippet = kept.join('\\n');
      if (snippet.length > COMMAND_OUTPUT_MAX_CHARS) {
        snippet = snippet.slice(0, COMMAND_OUTPUT_MAX_CHARS);
        truncated = true;
      }
      if (truncated) {
        snippet = snippet.trimEnd() + '\\n…';
      }
      return { snippet, truncated, full: text };
    }

    function appendCommandResult(ok, output, commandText, exitCode) {
      const normalizedCommand = typeof commandText === 'string' ? commandText : '';
      renderCommandView({
        id: activeCommandId,
        commandText: normalizedCommand || lastCommandText,
        status: ok ? 'completed' : 'failed',
        output,
        exitCode,
        title: ok ? '命令完成' : '命令失败',
      });
    }

    function finalizeStream(output) {
      clearTypingPlaceholder();
      if (streamState) {
        const finalText = output || streamState.buffer;
        streamState.message.bubble.innerHTML = renderMarkdown(finalText);
        recordCache('ai', finalText);
        streamState = null;
        autoScrollIfNeeded();
        return;
      }
      appendMessage('ai', output || '(无输出)', { markdown: true });
    }

    function handleResult(msg, conn) {
      const queued = conn?.pendingSends?.shift() || { type: 'prompt' };
      const kind = queued.type || queued;
      clearTypingPlaceholder();
      if (kind === 'command') {
        appendCommandResult(Boolean(msg.ok), msg.output || '', msg.command, msg.exit_code);
        resetIdleTimer();
        setBusy(false);
        return;
      }
      finalizeStream(msg.output || '');
      if (!planTouched) {
        renderPlanStatus('本轮未生成计划');
      }
      resetIdleTimer();
      setBusy(false);
    }

    function renderWorkspaceInfo(info) {
      if (!workspaceInfoEl) return;
      workspaceInfoEl.innerHTML = '';
      if (modifiedFilesEl) modifiedFilesEl.innerHTML = '';
      if (!info) return;
      if (info.path) {
        setWorkspaceForSession(currentSessionId, info.path);
      }
      if (info.path) {
        const span = document.createElement('span');
        span.className = 'path';
        span.textContent = info.path;
        workspaceInfoEl.appendChild(span);
      }
      if (modifiedFilesEl && Array.isArray(info.modified)) {
        if (info.modified.length === 0) {
          const span = document.createElement('span');
          span.textContent = '（无变更）';
          span.style.color = 'var(--muted)';
          modifiedFilesEl.appendChild(span);
        } else {
          info.modified.slice(0, 50).forEach((file) => {
            const span = document.createElement('span');
            span.textContent = file;
            modifiedFilesEl.appendChild(span);
          });
          if (info.modified.length > 50) {
            const span = document.createElement('span');
            span.textContent = '... 共 ' + info.modified.length + ' 个';
            span.style.color = 'var(--muted)';
            modifiedFilesEl.appendChild(span);
          }
        }
      }
    }

    function renderPlanStatus(text) {
      if (!planListEl) return;
      planListEl.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = text;
      planListEl.appendChild(span);
    }

    function renderPlan(items) {
      if (!planListEl) return;
      planTouched = true;
      savePlanCache(items || [], currentSessionId);
      planListEl.innerHTML = '';
      if (!items || items.length === 0) {
        renderPlanStatus('暂无计划');
        return;
      }
      items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'plan-item' + (item.completed ? ' done' : '');
        const marker = document.createElement('span');
        marker.className = 'plan-marker';
        marker.textContent = item.completed ? '✓' : String(idx + 1);
        const text = document.createElement('span');
        text.className = 'plan-text';
        text.textContent = item.text || '(未命名)';
        row.appendChild(marker);
        row.appendChild(text);
        planListEl.appendChild(row);
      });
    }

    function renderAttachments() {
      if (!attachmentsEl) return;
      attachmentsEl.innerHTML = '';
      pendingImages.forEach((img, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        const label = document.createElement('span');
        const sizeKb = Math.round((img.size || 0) / 1024);
        label.textContent = (img.name || '图片') + (sizeKb ? ' (' + sizeKb + 'KB)' : '');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          pendingImages.splice(idx, 1);
          renderAttachments();
        });
        chip.appendChild(label);
        chip.appendChild(remove);
        attachmentsEl.appendChild(chip);
      });
    }

    function addImagesFromFiles(files) {
      if (!files?.length) return;
      Array.from(files).forEach((file) => {
        if (!file.type.startsWith('image/')) {
          appendStatus('仅支持图片文件: ' + file.name);
          return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          appendStatus(file.name + ' 超过 2MB 限制');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== 'string') return;
          const base64 = result.includes(',') ? result.split(',').pop() || '' : result;
          pendingImages.push({ name: file.name, mime: file.type, size: file.size, data: base64 });
          renderAttachments();
        };
        reader.readAsDataURL(file);
      });
    }

    function clearAttachments() {
      pendingImages = [];
      if (imageInput) {
        imageInput.value = '';
      }
      renderAttachments();
    }

    tokenSubmit.addEventListener('click', () => {
      const token = tokenInput.value.trim();
      if (!token) return;
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionAliases = loadSessionAliases();
      renderSessionTabs();
      renderSessionList();
      updateSessionLabel(currentSessionId);
      tokenOverlay.classList.add('hidden');
      restoreFromCache();
      restorePlanFromCache();
      connect();
    });

    tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tokenSubmit.click();
      }
    });

    connect();

    if (sessionNewBtn) {
      sessionNewBtn.addEventListener('click', () => {
        const nextId = newSessionId();
        switchSession(nextId);
      });
    }

    if (sessionRenameBtn) {
      sessionRenameBtn.addEventListener('click', () => {
        if (!currentSessionId) return;
        const existing = getSessionAlias(currentSessionId);
        if (aliasInput) {
          aliasInput.value = existing || '';
          setTimeout(() => aliasInput?.focus(), 0);
        }
        if (aliasOverlay) {
          aliasOverlay.classList.remove('hidden');
        }
      });
    }

    if (sessionHistoryBtn) {
      sessionHistoryBtn.addEventListener('click', () => {
        renderSessionList();
        if (sessionDialog) {
          sessionDialog.classList.remove('hidden');
        }
      });
    }

    if (sessionDialogClose) {
      sessionDialogClose.addEventListener('click', () => {
        sessionDialog?.classList.add('hidden');
      });
    }

    function closeAliasOverlay() {
      aliasOverlay?.classList.add('hidden');
    }

    function submitAlias() {
      if (!currentSessionId) {
        closeAliasOverlay();
        return;
      }
      const name = aliasInput?.value || '';
      setSessionAlias(currentSessionId, name);
      closeAliasOverlay();
    }

    aliasSave?.addEventListener('click', submitAlias);
    aliasCancel?.addEventListener('click', closeAliasOverlay);
    aliasInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAlias();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAliasOverlay();
      }
    });
  </script>
</body>
</html>`;
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
      let parsed: WsMessage;
      try {
        parsed = JSON.parse(String(data)) as WsMessage;
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
              ws.send(JSON.stringify({ type: "delta", delta: event.delta }));
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
            const enrichedInput = applyToolGuide(promptInput.input);
            const result = await orchestrator.send(enrichedInput, { streaming: true, signal: controller.signal });
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
              sessionLogger.logOutput(typeof withTools.response === "string" ? withTools.response : String(withTools.response ?? ""));
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
        const agentArg = slash.body.trim();
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
            "使用 /agent <id> 切换代理，如 /agent claude。",
            "需要 Claude 协助时，请在消息中插入 <<<agent.claude ...>>> 指令块描述任务。",
          ].join("\n");
          ws.send(JSON.stringify({ type: "result", ok: true, output: message }));
          sessionLogger?.logOutput(message);
          return;
        }
        const normalized = agentArg.toLowerCase();
        if (normalized === "auto") {
          const output = "❌ 自动模式已停用，需要 Claude 时请手动插入 <<<agent.claude ...>>> 指令块。";
          ws.send(JSON.stringify({ type: "result", ok: false, output }));
          sessionLogger?.logOutput(output);
          return;
        }
        if (normalized === "manual") {
          const output = "ℹ️ 当前已经是手动协作模式，可直接继续使用。";
          ws.send(JSON.stringify({ type: "result", ok: true, output }));
          sessionLogger?.logOutput(output);
          return;
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
            runPromise.catch(() => {});
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
  // eslint-disable-next-line no-console
  console.error("[web] fatal error", error);
  process.exit(1);
});

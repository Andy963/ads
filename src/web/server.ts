import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";
import childProcess from "node:child_process";
import type { Input } from "@openai/codex-sdk";

import "../utils/env.js";
import { runAdsCommandLine } from "./commandRouter.js";
import { detectWorkspace } from "../workspace/detector.js";
import { DirectoryManager } from "../telegram/utils/directoryManager.js";
import { checkWorkspaceInit } from "../telegram/utils/workspaceInitChecker.js";
import { HybridOrchestrator } from "../agents/orchestrator.js";
import { CodexAgentAdapter } from "../agents/adapters/codexAdapter.js";
import { resolveClaudeAgentConfig } from "../agents/config.js";
import { ClaudeAgentAdapter } from "../agents/adapters/claudeAdapter.js";
import { SystemPromptManager, resolveReinjectionConfig } from "../systemPrompt/manager.js";
import { createLogger } from "../utils/logger.js";
import type { AgentAdapter } from "../agents/types.js";
import type { AgentEvent } from "../codex/events.js";
import { parseSlashCommand } from "../codexConfig.js";

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

function buildPromptInput(payload: unknown, imageDir: string): { ok: true; input: Input } | { ok: false; message: string } {
  if (typeof payload === "string") {
    const text = sanitizeInput(payload);
    if (!text) {
      return { ok: false, message: "Payload must be a text prompt" };
    }
    return { ok: true, input: text };
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
        return { ok: false, message: result.message };
      }
      inputParts.push({ type: "local_image", path: result.path });
    }
  }

  if (inputParts.length === 0) {
    return { ok: false, message: "payload 不能为空" };
  }

  if (inputParts.length === 1 && inputParts[0].type === "text") {
    return { ok: true, input: inputParts[0].text };
  }
  return { ok: true, input: inputParts };
}

function renderLandingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
    html, body { height: 100%; width: 100%; }
    body { font-family: "Inter", "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; min-height: var(--vh); height: var(--vh); overflow: hidden; overflow-x: hidden; overscroll-behavior: contain; display: flex; flex-direction: column; }
    header { padding: 14px 18px; background: var(--panel); border-bottom: 1px solid var(--border); box-shadow: 0 1px 3px rgba(15,23,42,0.06); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .header-row { display: flex; align-items: center; gap: 8px; }
    .ws-indicator { width: 12px; height: 12px; border-radius: 999px; background: #ef4444; border: 1px solid #e5e7eb; box-shadow: 0 0 0 2px #fff; }
    .ws-indicator.connecting { background: #f59e0b; box-shadow: 0 0 0 2px #fef3c7; animation: pulse 1s infinite alternate; }
    .ws-indicator.connected { background: #22c55e; box-shadow: 0 0 0 2px #dcfce7; animation: pulse 1s infinite alternate-reverse; }
    @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.15); } }
    header h1 { margin: 0; font-size: 18px; }
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 16px 12px 20px; display: flex; gap: 14px; flex: 1; min-height: 0; align-items: flex-start; overflow: hidden; box-sizing: border-box; max-height: calc(var(--vh) - var(--header-h)); }
    #sidebar { width: 240px; min-width: 220px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; box-shadow: 0 4px 12px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 10px; }
    .sidebar-title { font-size: 13px; font-weight: 600; margin: 0; color: var(--muted); }
    .workspace-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
    .workspace-list .path { color: var(--text); word-break: break-all; }
    .files-list { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text); max-height: 260px; overflow-y: auto; }
    #console { flex: 1; display: flex; flex-direction: column; gap: 12px; min-height: 0; width: 100%; overflow: hidden; max-height: 100%; }
    #log { flex: 1 1 0; min-height: 40vh; max-height: none; overflow-y: auto; overflow-x: hidden; padding: 14px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 22px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .msg { display: flex; flex-direction: column; gap: 6px; max-width: 100%; align-items: flex-start; }
    .msg.user { align-items: flex-start; }
    .msg.ai { align-items: flex-start; }
    .msg.status { align-items: flex-start; }
    .bubble { border-radius: 12px; padding: 12px 14px; line-height: 1.6; font-size: 14px; color: var(--text); max-width: 100%; word-break: break-word; overflow-wrap: anywhere; }
    .user .bubble { background: var(--user); }
    .ai .bubble { background: var(--ai); }
    .status .bubble { background: var(--status); color: var(--muted); font-size: 13px; }
    .meta { font-size: 12px; color: var(--muted); display: none; }
    .code-block { background: #0b1221; color: #f8fafc; padding: 12px; border-radius: 10px; overflow-x: auto; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
    .bubble code { background: rgba(15,23,42,0.07); padding: 2px 5px; border-radius: 6px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; }
    .bubble h1, .bubble h2, .bubble h3 { margin: 0 0 6px; line-height: 1.3; }
    .bubble p { margin: 0 0 8px; }
    .bubble ul { margin: 0 0 8px 18px; padding: 0; }
    .bubble a { color: var(--accent); text-decoration: none; }
    .bubble a:hover { text-decoration: underline; }
    .cmd-details summary { cursor: pointer; color: var(--accent); }
    #form { margin-top: auto; padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 4px 12px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; }
    #form-row { display: flex; align-items: center; gap: 8px; }
    #attach-btn { padding: 10px 12px; background: #eef2ff; border: 1px solid #c7d2fe; color: #312e81; border-radius: 8px; cursor: pointer; font-weight: 600; }
    #attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #status-label { font-size: 12px; color: var(--muted); }
    #input { width: 100%; padding: 12px; background: #fff; border: 1px solid var(--border); border-radius: 8px; font-size: 16px; min-height: 64px; max-height: 200px; resize: vertical; line-height: 1.5; overflow-x: hidden; white-space: pre-wrap; word-break: break-word; }
    #attachments { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; background: #eef2ff; color: #1e1b4b; border-radius: 8px; font-size: 12px; }
    .chip button { border: none; background: transparent; cursor: pointer; color: #6b7280; }
    .typing-bubble { display: flex; gap: 6px; align-items: center; }
    .typing-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; animation: typing 1s infinite; opacity: 0.6; }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing { 0% { transform: translateY(0); opacity: 0.6; } 50% { transform: translateY(-2px); opacity: 1; } 100% { transform: translateY(0); opacity: 0.6; } }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.35); backdrop-filter: blur(18px); display: flex; align-items: center; justify-content: center; }
    .overlay.hidden { display: none; }
    .overlay .card { background: #fff; border: 1px solid #d6d9e0; border-radius: 12px; padding: 20px 22px; width: 340px; box-shadow: 0 12px 30px rgba(15,23,42,0.12); display: flex; flex-direction: column; gap: 12px; position: relative; z-index: 2; }
    .overlay h2 { margin: 0; font-size: 18px; }
    .overlay p { margin: 0; color: #4b5563; font-size: 13px; }
    .overlay .row { display: flex; gap: 8px; align-items: center; }
    .overlay input { flex: 1; padding: 10px 12px; font-size: 16px; border: 1px solid #d6d9e0; border-radius: 8px; line-height: 1.2; }
    .overlay button { padding: 10px 14px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 16px; line-height: 1.2; white-space: nowrap; }
    body.locked header, body.locked main { filter: blur(18px); pointer-events: none; user-select: none; }
    @media (max-width: 640px) {
      main { padding: 12px 10px 16px; gap: 10px; max-width: 100%; max-height: calc(var(--vh) - var(--header-h)); }
      #sidebar { display: none; }
      #console { width: 100%; }
      #log { min-height: 60vh; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <span id="ws-indicator" class="ws-indicator" title="WebSocket disconnected" aria-label="WebSocket disconnected"></span>
      <h1>ADS Web Console</h1>
    </div>
  </header>
  <main>
    <aside id="sidebar">
      <h3 class="sidebar-title">Workspace</h3>
      <div id="workspace-info" class="workspace-list"></div>
      <h3 class="sidebar-title">Modified Files</h3>
      <div id="modified-files" class="files-list"></div>
    </aside>
    <section id="console">
      <div id="log"></div>
      <form id="form">
        <div id="form-row">
          <button id="attach-btn" type="button">📎 图片</button>
          <span id="status-label">已断开</span>
        </div>
        <div id="attachments"></div>
        <textarea id="input" autocomplete="off" placeholder="输入文本或 /ads 命令，Enter 发送，Shift+Enter 换行"></textarea>
        <input id="image-input" type="file" accept="image/*" multiple hidden />
      </form>
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
  <script>
    const logEl = document.getElementById('log');
    const inputEl = document.getElementById('input');
    const formEl = document.getElementById('form');
    const wsIndicator = document.getElementById('ws-indicator');
    const workspaceInfoEl = document.getElementById('workspace-info');
    const modifiedFilesEl = document.getElementById('modified-files');
    const tokenOverlay = document.getElementById('token-overlay');
    const tokenInput = document.getElementById('token-input');
    const tokenSubmit = document.getElementById('token-submit');
    const attachBtn = document.getElementById('attach-btn');
    const imageInput = document.getElementById('image-input');
    const attachmentsEl = document.getElementById('attachments');
    const statusLabel = document.getElementById('status-label');
    const idleMinutes = ${IDLE_MINUTES};
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    const MAX_LOG_MESSAGES = 300;
    const COMMAND_OUTPUT_MAX_LINES = 10;
    const COMMAND_OUTPUT_MAX_CHARS = 1200;
    const viewport = window.visualViewport;
    let ws;
    let sendQueue = [];
    let streamState = null;
    let autoScroll = true;
    let commandMessage = null;
    let idleTimer = null;
    let reconnectTimer = null;
    let pendingImages = [];
    let typingPlaceholder = null;
    let wsErrorMessage = null;

    function applyVh() {
      const vh = viewport ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--vh', vh + 'px');
    }
    applyVh();
    window.addEventListener('resize', applyVh);
    if (viewport) {
      viewport.addEventListener('resize', applyVh);
    }

    function recalcLogHeight() {
      if (!logEl) return;
      const headerEl = document.querySelector('header');
      const headerH = headerEl ? headerEl.getBoundingClientRect().height : 0;
      const formH = formEl ? formEl.getBoundingClientRect().height : 0;
      const vh = viewport ? viewport.height : window.innerHeight;
      const gap = 32; // padding/margins buffer
      const available = vh - headerH - formH - gap;
      const min = 180;
      const target = Math.max(min, available);
      logEl.style.maxHeight = target + 'px';
      logEl.style.minHeight = Math.max(min, Math.min(target, 0.6 * vh)) + 'px';
    }
    recalcLogHeight();

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
            const lang = seg.lang ? ' data-lang="' + escapeHtml(seg.lang) + '"' : '';
            return '<pre class="code-block"><code' + lang + '>' + code + '</code></pre>';
          }
          return renderTextBlock(seg.content);
        })
        .join('');
    }

    function autoScrollIfNeeded() {
      if (!autoScroll) return;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function pruneLog() {
      if (!logEl) return;
      while (logEl.children.length > MAX_LOG_MESSAGES) {
        const first = logEl.firstElementChild;
        if (!first) break;
        logEl.removeChild(first);
      }
      if (typingPlaceholder?.wrapper && !typingPlaceholder.wrapper.isConnected) {
        typingPlaceholder = null;
      }
      if (commandMessage?.wrapper && !commandMessage.wrapper.isConnected) {
        commandMessage = null;
      }
    }

    function setLocked(locked) {
      document.body.classList.toggle('locked', !!locked);
    }

    function scheduleReconnect() {
      if (!tokenOverlay.classList.contains('hidden')) return;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
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
      return { wrapper, bubble };
    }

    function appendStatus(text) {
      return appendMessage('status', text, { status: true });
    }

    function clearTypingPlaceholder() {
      if (typingPlaceholder?.wrapper?.isConnected) {
        typingPlaceholder.wrapper.remove();
      }
      typingPlaceholder = null;
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
      return typingPlaceholder;
    }

    function getOrCreateCommandMessage() {
      if (commandMessage && commandMessage.wrapper?.isConnected) {
        return commandMessage;
      }
      commandMessage = appendMessage('status', '', { status: true });
      return commandMessage;
    }

    function showCommand(text) {
      clearTypingPlaceholder();
      streamState = null;
      const msg = getOrCreateCommandMessage();
      msg.bubble.textContent = text;
    }

    function clearCommand() {
      if (commandMessage?.wrapper?.isConnected) {
        commandMessage.wrapper.remove();
      }
      commandMessage = null;
    }

    function setWsState(state) {
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
    }

    const TOKEN_KEY = 'ADS_WEB_TOKEN';

    function resetIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        const reason = '空闲超过 ' + idleMinutes + ' 分钟，已锁定';
        sessionStorage.removeItem(TOKEN_KEY);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(4400, "idle timeout");
        }
        tokenOverlay.classList.remove('hidden');
        tokenInput.value = '';
        setLocked(true);
        appendMessage('ai', reason, { status: true });
        setWsState('disconnected');
      }, idleMinutes * 60 * 1000);
    }

    function connect() {
      let token = sessionStorage.getItem(TOKEN_KEY) || '';
      if (!token) {
        tokenOverlay.classList.remove('hidden');
        tokenInput.focus();
        setLocked(true);
        return;
      }
      tokenOverlay.classList.add('hidden');
      setLocked(false);
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname;
      setWsState('connecting');
      ws = new WebSocket(url, ['ads-token', token]);
      ws.onopen = () => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (wsErrorMessage?.wrapper?.isConnected) {
          wsErrorMessage.wrapper.remove();
          wsErrorMessage = null;
        }
        setWsState('connected');
        resetIdleTimer();
        setLocked(false);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'result') {
            handleResult(msg);
          } else if (msg.type === 'delta') {
            handleDelta(msg.delta || '');
          } else if (msg.type === 'command') {
            showCommand(msg.detail || '命令执行中');
            return;
          } else if (msg.type === 'welcome') {
            setWsState('connected');
            if (msg.workspace) {
              renderWorkspaceInfo(msg.workspace);
            }
          } else if (msg.type === 'workspace') {
            renderWorkspaceInfo(msg.data);
          } else if (msg.type === 'error') {
            const failedKind = sendQueue.shift() || 'prompt';
            clearTypingPlaceholder();
            streamState = null;
            if (failedKind === 'command') {
              showCommand('命令失败');
              appendMessage('ai', msg.message || '错误', { status: true });
              clearCommand();
            } else {
              appendMessage('ai', msg.message || '错误', { status: true });
            }
            return;
          } else {
            appendMessage('ai', ev.data, { status: true });
          }
        } catch {
          appendMessage('ai', ev.data, { status: true });
        }
      };
      ws.onclose = (ev) => {
        setWsState('disconnected');
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (ev.code === 4401) {
          sessionStorage.removeItem(TOKEN_KEY);
          tokenOverlay.classList.remove('hidden');
          tokenInput.value = '';
          setLocked(true);
          appendMessage('ai', '口令无效或已过期，请重新输入', { status: true });
        } else if (ev.code === 4409) {
          appendMessage('ai', '已有新连接，当前会话被替换', { status: true });
        }
        renderWorkspaceInfo(null);
        scheduleReconnect();
      };
      ws.onerror = (err) => {
        setWsState('disconnected');
        const message = err && typeof err === 'object' && 'message' in err && err.message ? String(err.message) : 'WebSocket error';
        if (!wsErrorMessage || !wsErrorMessage.wrapper?.isConnected) {
          wsErrorMessage = appendMessage('ai', 'WS error: ' + message, { status: true });
        }
        scheduleReconnect();
      };
    }

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (formEl.requestSubmit) {
          formEl.requestSubmit();
        } else {
          formEl.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
      resetIdleTimer();
      recalcLogHeight();
    });

    inputEl.addEventListener('focus', recalcLogHeight);
    inputEl.addEventListener('blur', recalcLogHeight);

    if (attachBtn && imageInput) {
      attachBtn.addEventListener('click', () => imageInput.click());
    }

    if (imageInput) {
      imageInput.addEventListener('change', () => addImagesFromFiles(imageInput.files));
    }

    formEl.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    formEl.addEventListener('drop', (e) => {
      e.preventDefault();
      addImagesFromFiles(e.dataTransfer?.files || []);
    });

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      const hasImages = pendingImages.length > 0;
      if ((!text && !hasImages) || !ws || ws.readyState !== WebSocket.OPEN) return;
      const isCommand = text.startsWith('/');
      const type = isCommand ? 'command' : 'prompt';
      const payload = isCommand
        ? text
        : {
            text,
            images: hasImages ? pendingImages : undefined,
          };
      autoScroll = true;
      ws.send(JSON.stringify({ type, payload }));
      sendQueue.push(type);
      if (isCommand) {
        showCommand('执行中: ' + text);
      } else {
        appendMessage('user', text || '(图片)');
        appendTypingPlaceholder();
        streamState = null;
      }
      inputEl.value = '';
      clearAttachments();
      inputEl.focus();
      resetIdleTimer();
    });

    function ensureStream() {
      if (!streamState) {
        clearTypingPlaceholder();
        streamState = {
          buffer: '',
          message: appendMessage('ai', '', { markdown: false }),
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

    function appendCommandResult(ok, output) {
      showCommand(ok ? '命令完成' : '命令失败');
      const { bubble } = appendMessage('ai', '', { status: true });
      const { snippet, truncated, full } = summarizeCommandOutput(output);
      const heading = document.createElement('div');
      heading.textContent = ok
        ? truncated
          ? '命令已执行（已截断前10行）'
          : '命令已执行'
        : truncated
          ? '命令失败（已截断前10行）'
          : '命令失败';
      bubble.appendChild(heading);
      const snippetEl = document.createElement('div');
      snippetEl.innerHTML = renderMarkdown(snippet);
      bubble.appendChild(snippetEl);

      if (truncated && full) {
        const details = document.createElement('details');
        details.className = 'cmd-details';
        const s = document.createElement('summary');
        s.textContent = '展开完整输出';
        details.appendChild(s);
        const fullEl = document.createElement('div');
        fullEl.innerHTML = renderMarkdown(full);
        details.appendChild(fullEl);
        bubble.appendChild(details);
      }
      autoScrollIfNeeded();
    }

    function finalizeStream(output) {
      clearTypingPlaceholder();
      if (streamState) {
        const finalText = output || streamState.buffer;
        streamState.message.bubble.innerHTML = renderMarkdown(finalText);
        streamState = null;
        autoScrollIfNeeded();
        return;
      }
      appendMessage('ai', output || '(无输出)', { markdown: true });
    }

    function handleResult(msg) {
      const kind = sendQueue.shift() || 'prompt';
      clearTypingPlaceholder();
      if (kind === 'command') {
        appendCommandResult(Boolean(msg.ok), msg.output || '');
        clearCommand();
        return;
      }
      finalizeStream(msg.output || '');
      resetIdleTimer();
    }

    function renderWorkspaceInfo(info) {
      if (!workspaceInfoEl) return;
      workspaceInfoEl.innerHTML = '';
      if (modifiedFilesEl) modifiedFilesEl.innerHTML = '';
      if (!info) return;
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
      tokenOverlay.classList.add('hidden');
      connect();
    });

    tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tokenSubmit.click();
      }
    });

    connect();
  </script>
</body>
</html>`;
}

async function start(): Promise<void> {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server });

  const workspaceRoot = detectWorkspace();
  await ensureWebPidFile(workspaceRoot);
  const allowedDirs = resolveAllowedDirs(workspaceRoot);
  const clients: Set<WebSocket> = new Set();

  wss.on("connection", (ws: WebSocket, req) => {
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const wsToken =
      Array.isArray(protocolHeader) && protocolHeader.length > 0
        ? protocolHeader[protocolHeader.length - 1]
        : typeof protocolHeader === "string"
          ? protocolHeader.split(",").map((p) => p.trim()).pop()
          : undefined;
    if (TOKEN && wsToken !== TOKEN) {
      ws.close(4401, "unauthorized");
      return;
    }

    if (clients.size >= MAX_CLIENTS) {
      const [first] = clients;
      first?.close(4409, "replaced by new connection");
      clients.delete(first as WebSocket);
    }
    clients.add(ws);

    const clientKey = wsToken && wsToken.length > 0 ? wsToken : "default";
    const directoryManager = new DirectoryManager(allowedDirs);
    const userId = 0;
    const cachedWorkspace = workspaceCache.get(clientKey);
    let currentCwd = directoryManager.getUserCwd(userId);
    if (cachedWorkspace) {
      const restoreResult = directoryManager.setUserCwd(userId, cachedWorkspace);
      if (!restoreResult.success) {
        logger.warn(`[Web][WorkspaceRestore] failed path=${cachedWorkspace} reason=${restoreResult.error}`);
      } else {
        currentCwd = directoryManager.getUserCwd(userId);
      }
    }
    workspaceCache.set(clientKey, currentCwd);

    const systemPromptManager = new SystemPromptManager({
      workspaceRoot: currentCwd,
      reinjection: resolveReinjectionConfig("WEB"),
      logger,
    });
    const adapters: AgentAdapter[] = [
      new CodexAgentAdapter({
        workingDirectory: currentCwd,
        systemPromptManager,
        metadata: { name: "Codex Web" },
      }),
    ];
    const claudeConfig = resolveClaudeAgentConfig();
    if (claudeConfig.enabled) {
      adapters.push(new ClaudeAgentAdapter({ config: claudeConfig }));
    }
    const orchestrator = new HybridOrchestrator({
      adapters,
      defaultAgentId: adapters[0].id,
      initialWorkingDirectory: currentCwd,
    });

    log("client connected");
    ws.send(
      JSON.stringify({
        type: "welcome",
        message: "ADS WebSocket bridge ready. Send {type:'command', payload:'/ads.status'}",
        workspace: getWorkspaceState(currentCwd),
      }),
    );

    ws.on("message", async (data: RawData) => {
      let parsed: WsMessage;
      try {
        parsed = JSON.parse(String(data)) as WsMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
        return;
      }

      const isPrompt = parsed.type === "prompt";
      const isCommand = parsed.type === "command";

      if (isPrompt) {
        const imageDir = path.join(currentCwd, ".ads", "temp", "web-images");
        const promptInput = buildPromptInput(parsed.payload, imageDir);
        if (!promptInput.ok) {
          ws.send(JSON.stringify({ type: "error", message: promptInput.message }));
          return;
        }
        const status = orchestrator.status();
        if (!status.ready) {
          ws.send(JSON.stringify({ type: "error", message: status.error ?? "代理未启用，请配置凭证" }));
          return;
        }
        orchestrator.setWorkingDirectory(currentCwd);
        const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
          if (event.delta) {
            ws.send(JSON.stringify({ type: "delta", delta: event.delta }));
            return;
          }
          if (event.phase === "command") {
            ws.send(
              JSON.stringify({
                type: "command",
                detail: event.detail ?? event.title,
              }),
            );
            return;
          }
          if (event.phase === "error") {
            ws.send(JSON.stringify({ type: "error", message: event.detail ?? event.title }));
          }
        });
        try {
          const result = await orchestrator.send(promptInput.input, { streaming: true });
          ws.send(JSON.stringify({ type: "result", ok: true, output: result.response }));
          sendWorkspaceState(ws, currentCwd);
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", message: (error as Error).message ?? String(error) }));
        } finally {
          unsubscribe();
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

      const slash = parseSlashCommand(command);
      if (slash?.command === "pwd") {
        ws.send(JSON.stringify({ type: "result", ok: true, output: `📁 当前工作目录: ${currentCwd}` }));
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
          ws.send(JSON.stringify({ type: "result", ok: false, output: `❌ ${result.error}` }));
          return;
        }
        currentCwd = directoryManager.getUserCwd(userId);
        workspaceCache.set(clientKey, currentCwd);
        orchestrator.setWorkingDirectory(currentCwd);
        systemPromptManager.setWorkspaceRoot(currentCwd);

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
            `[Web][WorkspaceInit] path=${currentCwd} missing=${missing}${
              initStatus.details ? ` details=${initStatus.details}` : ""
            }`,
          );
        }
        ws.send(JSON.stringify({ type: "result", ok: true, output: message }));
        sendWorkspaceState(ws, currentCwd);
        return;
      }

      let previousWorkspaceEnv: string | undefined;
      try {
        previousWorkspaceEnv = process.env.AD_WORKSPACE;
        process.env.AD_WORKSPACE = currentCwd;
        const result = await runAdsCommandLine(command);
        ws.send(JSON.stringify({ type: "result", ok: result.ok, output: result.output }));
        sendWorkspaceState(ws, currentCwd);
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: (error as Error).message ?? String(error),
          }),
        );
      } finally {
        if (previousWorkspaceEnv === undefined) {
          delete process.env.AD_WORKSPACE;
        } else {
          process.env.AD_WORKSPACE = previousWorkspaceEnv;
        }
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

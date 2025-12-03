import http from "node:http";
import path from "node:path";
import fs from "node:fs";

import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";

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

const PORT = Number(process.env.ADS_WEB_PORT) || 8787;
const HOST = process.env.ADS_WEB_HOST || "0.0.0.0";
const logger = createLogger("WebSocket");

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
  const raw = process.env.ADS_WEB_ALLOWED_DIRS;
  const list = (raw ? raw.split(",") : [workspaceRoot]).map((dir) => dir.trim()).filter(Boolean);
  const resolved = list.map((dir) => path.resolve(dir));
  return resolved.length > 0 ? resolved : [workspaceRoot];
}

function createHttpServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLandingPage());
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
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

function getWorkspaceInfo(): string {
  try {
    const workspace = detectWorkspace();
    const adsRules = path.join(workspace, ".ads", "rules.md");
    return [
      `Workspace: ${workspace}`,
      `Rules: ${fs.existsSync(adsRules) ? adsRules : "missing"}`,
      `PID: ${process.pid}`,
    ].join(" | ");
  } catch (error) {
    return `Workspace detection failed: ${(error as Error).message}`;
  }
}

function renderLandingPage(): string {
  const info = getWorkspaceInfo();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ADS Web Console</title>
  <style>
    :root {
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
    body { font-family: "Inter", "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 14px 18px; background: var(--panel); border-bottom: 1px solid var(--border); box-shadow: 0 1px 3px rgba(15,23,42,0.06); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .header-row { display: flex; align-items: center; gap: 8px; }
    .ws-indicator { width: 12px; height: 12px; border-radius: 999px; background: #ef4444; border: 1px solid #e5e7eb; box-shadow: 0 0 0 2px #fff; }
    .ws-indicator.connecting { background: #f59e0b; box-shadow: 0 0 0 2px #fef3c7; }
    .ws-indicator.connected { background: #22c55e; box-shadow: 0 0 0 2px #dcfce7; }
    header h1 { margin: 0; font-size: 18px; }
    header p { margin: 6px 0 0; font-size: 13px; color: var(--muted); }
    main { max-width: 960px; width: 100%; margin: 0 auto; padding: 16px 12px 20px; display: flex; flex-direction: column; gap: 12px; flex: 1; }
    #log { flex: 1 1 0; min-height: 60vh; max-height: 74vh; overflow-y: auto; padding: 14px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 22px rgba(15,23,42,0.04); display: flex; flex-direction: column; gap: 12px; }
    .msg { display: flex; flex-direction: column; gap: 6px; max-width: 100%; align-items: flex-start; }
    .msg.user { align-items: flex-start; }
    .msg.ai { align-items: flex-start; }
    .msg.status { align-items: flex-start; }
    .bubble { border-radius: 12px; padding: 12px 14px; line-height: 1.6; font-size: 14px; color: var(--text); max-width: 100%; word-break: break-word; }
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
    #form { margin-top: auto; padding: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 4px 12px rgba(15,23,42,0.04); }
    #input { width: 100%; padding: 12px; background: #fff; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; min-height: 64px; max-height: 200px; resize: vertical; line-height: 1.5; }
    @media (max-width: 640px) {
      main { padding: 12px 10px 16px; }
      #log { min-height: 55vh; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <span id="ws-indicator" class="ws-indicator" title="WebSocket disconnected" aria-label="WebSocket disconnected"></span>
      <h1>ADS Web Console</h1>
    </div>
    <p>${info}</p>
  </header>
  <main>
    <div id="log"></div>
    <form id="form">
      <textarea id="input" autocomplete="off" placeholder="输入文本或 /ads 命令，Enter 发送，Shift+Enter 换行"></textarea>
    </form>
  </main>
  <script>
    const logEl = document.getElementById('log');
    const inputEl = document.getElementById('input');
    const formEl = document.getElementById('form');
    const wsIndicator = document.getElementById('ws-indicator');
    let ws;
    let sendQueue = [];
    let streamState = null;
    let autoScroll = true;
    let commandMessage = null;

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
      autoScrollIfNeeded();
      return { wrapper, bubble };
    }

    function appendStatus(text) {
      return appendMessage('status', text, { status: true });
    }

    function getOrCreateCommandMessage() {
      if (commandMessage && commandMessage.wrapper?.isConnected) {
        return commandMessage;
      }
      commandMessage = appendMessage('status', '', { status: true });
      return commandMessage;
    }

    function showCommand(text) {
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
      if (!wsIndicator) return;
      wsIndicator.classList.remove('connected', 'connecting');
      if (state === 'connected') {
        wsIndicator.classList.add('connected');
      } else if (state === 'connecting') {
        wsIndicator.classList.add('connecting');
      }
      const label =
        state === 'connected'
          ? 'WebSocket connected'
          : state === 'connecting'
          ? 'WebSocket connecting'
          : 'WebSocket disconnected';
      wsIndicator.setAttribute('title', label);
      wsIndicator.setAttribute('aria-label', label);
    }

    function connect() {
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
      setWsState('connecting');
      ws = new WebSocket(url);
      ws.onopen = () => setWsState('connected');
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
          } else if (msg.type === 'error') {
            if (sendQueue.length > 0) {
              sendQueue.shift();
            }
            streamState = null;
            showCommand('命令失败');
            appendMessage('ai', msg.message || '错误', { status: true });
            clearCommand();
            return;
          } else {
            appendMessage('ai', ev.data, { status: true });
          }
        } catch {
          appendMessage('ai', ev.data, { status: true });
        }
      };
      ws.onclose = () => setWsState('disconnected');
      ws.onerror = (err) => {
        setWsState('disconnected');
        appendMessage('ai', 'WS error: ' + err.message, { status: true });
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
    });

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      const isCommand = text.startsWith('/');
      const type = isCommand ? 'command' : 'prompt';
      ws.send(JSON.stringify({ type, payload: text }));
      sendQueue.push(type);
      if (isCommand) {
        showCommand('执行中: ' + text);
      } else {
        appendMessage('user', text);
      }
      inputEl.value = '';
      inputEl.focus();
    });

    function ensureStream() {
      if (!streamState) {
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
    }

    function appendCommandResult(ok, output) {
      showCommand(ok ? '命令完成' : '命令失败');
      const { bubble } = appendMessage('ai', '', { status: true });
      const summary = document.createElement('div');
      summary.textContent = ok ? '命令已执行（查看输出）' : '命令失败（查看详情）';
      bubble.appendChild(summary);
      const details = document.createElement('details');
      details.className = 'cmd-details';
      const s = document.createElement('summary');
      s.textContent = '展开输出';
      details.appendChild(s);
      const pre = document.createElement('pre');
      pre.textContent = output || '(无输出)';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      details.appendChild(pre);
      bubble.appendChild(details);
      autoScrollIfNeeded();
    }

    function finalizeStream(output) {
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
      if (kind === 'command') {
        appendCommandResult(Boolean(msg.ok), msg.output || '');
        clearCommand();
        return;
      }
      finalizeStream(msg.output || '');
    }

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

  wss.on("connection", (ws: WebSocket) => {
    const directoryManager = new DirectoryManager(allowedDirs);
    const userId = 0;
    let currentCwd = directoryManager.getUserCwd(userId);

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
        workspace: getWorkspaceInfo(),
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
        const promptText = sanitizeInput(parsed.payload);
        if (!promptText) {
          ws.send(JSON.stringify({ type: "error", message: "Payload must be a text prompt" }));
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
          const result = await orchestrator.send(promptText, { streaming: true });
          ws.send(JSON.stringify({ type: "result", ok: true, output: result.response }));
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
        return;
      }

      let previousWorkspaceEnv: string | undefined;
      try {
        previousWorkspaceEnv = process.env.AD_WORKSPACE;
        process.env.AD_WORKSPACE = currentCwd;
        const result = await runAdsCommandLine(command);
        ws.send(JSON.stringify({ type: "result", ok: result.ok, output: result.output }));
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
  });

  server.listen(PORT, HOST, () => {
    log(`WebSocket server listening on ws://${HOST}:${PORT}`);
    log(getWorkspaceInfo());
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[web] fatal error", error);
  process.exit(1);
});

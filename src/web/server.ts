import http from "node:http";
import path from "node:path";
import fs from "node:fs";

import { WebSocketServer } from "ws";
import type { WebSocket, RawData } from "ws";

import { runAdsCommandLine } from "./commandRouter.js";
import { detectWorkspace } from "../workspace/detector.js";
import { HybridOrchestrator } from "../agents/orchestrator.js";
import { CodexAgentAdapter } from "../agents/adapters/codexAdapter.js";
import { resolveClaudeAgentConfig } from "../agents/config.js";
import { ClaudeAgentAdapter } from "../agents/adapters/claudeAdapter.js";
import { SystemPromptManager, resolveReinjectionConfig } from "../systemPrompt/manager.js";
import { createLogger } from "../utils/logger.js";
import type { AgentAdapter } from "../agents/types.js";
import type { AgentEvent } from "../codex/events.js";

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
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ADS WebSocket Console</title>
  <style>
    body { font-family: monospace; background: #0b1021; color: #e6edf3; margin: 0; padding: 0; }
    header { padding: 12px 16px; background: #111831; border-bottom: 1px solid #1f2b4a; }
    header h1 { margin: 0; font-size: 18px; }
    header p { margin: 4px 0 0; font-size: 12px; color: #9ab; }
    #log { height: 60vh; overflow: auto; padding: 12px 16px; background: #0f162f; }
    #log pre { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
    #form { display: flex; padding: 12px 16px; gap: 8px; background: #0b1021; border-top: 1px solid #1f2b4a; }
    #input { flex: 1; padding: 10px; background: #0f162f; border: 1px solid #1f2b4a; color: #e6edf3; font-family: monospace; }
    button { padding: 10px 14px; background: #1f6feb; color: #fff; border: none; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <header>
    <h1>ADS Web Console</h1>
    <p>${info}</p>
  </header>
  <div id="log"></div>
  <form id="form">
    <input id="input" autocomplete="off" placeholder="输入文本或 /ads 命令，回车发送" />
    <button type="submit">Send</button>
  </form>
  <script>
    const logEl = document.getElementById('log');
    const inputEl = document.getElementById('input');
    const formEl = document.getElementById('form');
    let ws;

    function append(type, text) {
      const pre = document.createElement('pre');
      pre.textContent = '[' + type + '] ' + text;
      logEl.appendChild(pre);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function connect() {
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
      ws = new WebSocket(url);
      ws.onopen = () => append('info', 'WebSocket connected');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'result') append(msg.ok ? 'ok' : 'err', msg.output || '');
          else if (msg.type === 'event') append('event', msg.title + (msg.detail ? ' - ' + msg.detail : ''));
          else if (msg.type === 'welcome') append('info', msg.message);
          else if (msg.type === 'error') append('err', msg.message);
          else append('msg', ev.data);
        } catch {
          append('raw', ev.data);
        }
      };
      ws.onclose = () => append('info', 'WebSocket closed');
      ws.onerror = (err) => append('err', 'WS error: ' + err.message);
    }

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      const type = text.startsWith('/') ? 'command' : 'prompt';
      ws.send(JSON.stringify({ type, payload: text }));
      append('you', text);
      inputEl.value = '';
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
  const systemPromptManager = new SystemPromptManager({
    workspaceRoot,
    reinjection: resolveReinjectionConfig("WEB"),
    logger,
  });
  const adapters: AgentAdapter[] = [
    new CodexAgentAdapter({
      workingDirectory: workspaceRoot,
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
    initialWorkingDirectory: workspaceRoot,
  });

  wss.on("connection", (ws: WebSocket) => {
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
        const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
          const payload: Record<string, unknown> = {
            type: "event",
            phase: event.phase,
            title: event.title,
          };
          if (event.detail) payload.detail = event.detail;
          if (event.delta) payload.delta = event.delta;
          ws.send(JSON.stringify(payload));
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

      try {
        const result = await runAdsCommandLine(command);
        ws.send(JSON.stringify({ type: "result", ok: result.ok, output: result.output }));
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: (error as Error).message ?? String(error),
          }),
        );
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

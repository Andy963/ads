import http from "node:http";
import path from "node:path";
import fs from "node:fs";

import { WebSocketServer } from "ws";

import { runAdsCommandLine } from "./commandRouter.js";
import { detectWorkspace } from "../workspace/detector.js";

interface WsMessage {
  type: string;
  payload?: unknown;
}

const PORT = Number(process.env.ADS_WEB_PORT) || 8787;
const HOST = process.env.ADS_WEB_HOST || "0.0.0.0";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[web]", ...args);
}

function createHttpServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ADS WebSocket bridge is running.\nConnect via WS and send {type:'command', payload:'/ads.status'}");
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

async function start(): Promise<void> {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    log("client connected");
    ws.send(
      JSON.stringify({
        type: "welcome",
        message: "ADS WebSocket bridge ready. Send {type:'command', payload:'/ads.status'}",
        workspace: getWorkspaceInfo(),
      }),
    );

    ws.on("message", async (data) => {
      let parsed: WsMessage;
      try {
        parsed = JSON.parse(String(data)) as WsMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
        return;
      }

      if (parsed.type !== "command") {
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

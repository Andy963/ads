import type http from "node:http";

import { readJsonBody, sendJson } from "../http.js";

import { verifyMcpBearerToken } from "./auth.js";
import type { McpTool, McpToolContext } from "./types.js";
import { createMcpRouter } from "./router.js";

function wantsEventStream(req: http.IncomingMessage): boolean {
  const raw = req.headers["accept"];
  const value = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  return value.toLowerCase().includes("text/event-stream");
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const raw = req.headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const header = String(value ?? "").trim();
  if (!header) return null;
  const prefix = "bearer ";
  if (header.toLowerCase().startsWith(prefix)) {
    const token = header.slice(prefix.length).trim();
    return token || null;
  }
  return null;
}

function sendEventStream(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

export function createMcpRequestHandler(deps: {
  pepper: string;
  tools: McpTool[];
  broadcastPlanner: (auth: { authUserId: string; sessionId: string; chatSessionId: string; historyKey: string; workspaceRoot: string }, payload: unknown) => void;
}): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const router = createMcpRouter(deps.tools);

  return async (req, res) => {
    const method = String(req.method ?? "").toUpperCase();

    if (method === "GET") {
      sendJson(res, 200, { ok: true, name: "ads-mcp", tools: deps.tools.map((t) => t.descriptor.name) });
      return true;
    }

    if (method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return true;
    }

    const token = extractBearerToken(req);
    if (!token) {
      const err = { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } };
      if (wantsEventStream(req)) {
        sendEventStream(res, 401, err);
      } else {
        sendJson(res, 401, err);
      }
      return true;
    }

    const verified = verifyMcpBearerToken({ token, pepper: deps.pepper });
    if (!verified.ok) {
      const err = { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized", data: { reason: verified.error } } };
      if (wantsEventStream(req)) {
        sendEventStream(res, 401, err);
      } else {
        sendJson(res, 401, err);
      }
      return true;
    }

    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    const broadcastPlanner = (msg: unknown): void => {
      deps.broadcastPlanner(verified.context, msg);
    };

    const ctx: McpToolContext = {
      auth: verified.context,
      req,
      broadcastPlanner,
    };

    const response = await router.handle(payload, ctx);
    if (response === null) {
      res.writeHead(204).end();
      return true;
    }

    if (wantsEventStream(req)) {
      sendEventStream(res, 200, response);
      return true;
    }

    sendJson(res, 200, response);
    return true;
  };
}

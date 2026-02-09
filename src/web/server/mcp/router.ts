import type { JsonRpcRequest, JsonRpcResponse, McpTool, McpToolContext } from "./types.js";

const SERVER_INFO = {
  name: "ads",
  version: "0.1.0",
};

function makeError(id: JsonRpcResponse["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

function makeResult(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function toId(value: unknown): string | number | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null) return null;
  return null;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") return false;
  if (typeof obj.method !== "string" || !obj.method.trim()) return false;
  return true;
}

function coerceParams(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function createMcpRouter(tools: McpTool[]) {
  const toolByName = new Map<string, McpTool>();
  for (const tool of tools) {
    toolByName.set(tool.descriptor.name, tool);
  }

  const listTools = () => ({
    tools: tools.map((t) => t.descriptor),
  });

  const callTool = async (params: unknown, ctx: McpToolContext) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Invalid params");
    }
    const obj = params as { name?: unknown; arguments?: unknown };
    const name = String(obj.name ?? "").trim();
    if (!name) {
      throw new Error("Tool name is required");
    }
    const tool = toolByName.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.call(obj.arguments ?? null, ctx);
  };

  const initialize = (params: unknown) => {
    const pv = (() => {
      if (!params || typeof params !== "object" || Array.isArray(params)) return "";
      const raw = (params as { protocolVersion?: unknown }).protocolVersion;
      return typeof raw === "string" ? raw.trim() : "";
    })();
    return {
      protocolVersion: pv || "2024-11-05",
      serverInfo: SERVER_INFO,
      capabilities: {
        tools: { listChanged: false },
      },
    };
  };

  const handleOne = async (req: JsonRpcRequest, ctx: McpToolContext): Promise<JsonRpcResponse | null> => {
    const id = req.id === undefined ? null : toId(req.id);
    const method = req.method.trim();
    const params = coerceParams(req.params);

    const isNotification = req.id === undefined;
    if (isNotification) {
      return null;
    }

    try {
      if (method === "initialize") {
        return makeResult(id, initialize(params));
      }
      if (method === "tools/list") {
        return makeResult(id, listTools());
      }
      if (method === "tools/call") {
        const result = await callTool(params, ctx);
        return makeResult(id, result);
      }
      if (method === "ping") {
        return makeResult(id, { ok: true });
      }
      return makeError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makeError(id, -32603, message);
    }
  };

  const handle = async (payload: unknown, ctx: McpToolContext): Promise<JsonRpcResponse | JsonRpcResponse[] | null> => {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return makeError(null, -32600, "Invalid Request");
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of payload) {
        if (!isRequest(item)) {
          responses.push(makeError(null, -32600, "Invalid Request"));
          continue;
        }
        const resp = await handleOne(item, ctx);
        if (resp) responses.push(resp);
      }
      return responses.length > 0 ? responses : null;
    }

    if (!isRequest(payload)) {
      return makeError(null, -32600, "Invalid Request");
    }
    return await handleOne(payload, ctx);
  };

  return { handle };
}


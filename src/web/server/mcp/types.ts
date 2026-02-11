import type http from "node:http";

import type { McpAuthContext } from "./auth.js";

export type JsonSchema = Record<string, unknown>;

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
};

export type McpToolCallResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "json"; json: unknown }
  >;
};

export type McpToolContext = {
  auth: McpAuthContext;
  rpcId?: JsonRpcId;
  req: http.IncomingMessage;
  broadcastPlanner: (payload: unknown) => void;
};

export interface McpTool {
  descriptor: McpToolDescriptor;
  call: (args: unknown, ctx: McpToolContext) => Promise<McpToolCallResult>;
}

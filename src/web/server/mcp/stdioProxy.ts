import { createInterface } from "node:readline";

type JsonRpcId = string | number | null;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRpcId(value: unknown): JsonRpcId | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function buildJsonRpcErrorResponse(id: JsonRpcId, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message,
      data,
    },
  };
}

function extractRequestId(payload: unknown): { hasId: boolean; id: JsonRpcId } {
  if (!isObject(payload)) {
    return { hasId: true, id: null };
  }
  if (!("id" in payload)) {
    return { hasId: false, id: null };
  }
  return { hasId: true, id: parseJsonRpcId(payload.id) };
}

function resolveMcpUrl(): string {
  const raw = String(process.env.ADS_MCP_URL ?? "").trim();
  if (raw) return raw;
  return "http://127.0.0.1:8787/mcp";
}

function resolveBearerToken(): string | null {
  const raw = String(process.env.ADS_MCP_BEARER_TOKEN ?? "").trim();
  return raw ? raw : null;
}

async function forwardToHttp(payload: unknown): Promise<unknown | null> {
  const token = resolveBearerToken();
  if (!token) {
    const { hasId, id } = extractRequestId(payload);
    if (!hasId) return null;
    return buildJsonRpcErrorResponse(id, "Missing ADS_MCP_BEARER_TOKEN.");
  }

  const url = resolveMcpUrl();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const { hasId, id } = extractRequestId(payload);
    if (!hasId) return null;
    const message = error instanceof Error ? error.message : String(error);
    return buildJsonRpcErrorResponse(id, `Failed to reach MCP endpoint: ${message}`, { url });
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const { hasId, id } = extractRequestId(payload);
    if (!hasId) return null;
    const message = error instanceof Error ? error.message : String(error);
    return buildJsonRpcErrorResponse(id, `Invalid MCP HTTP response JSON: ${message}`, {
      status: response.status,
      bodySnippet: trimmed.slice(0, 400),
    });
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = String(line ?? "").trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    const response = await forwardToHttp(parsed);
    if (response === null) {
      continue;
    }

    try {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[ads-mcp-proxy] ${message}\n`);
  } catch {
    // ignore
  }
  process.exitCode = 1;
});


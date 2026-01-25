import { createRequire } from "node:module";

import "../utils/logSink.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createLogger } from "../utils/logger.js";
import { search } from "../tools/search/index.js";
import { searchHistoryForAgent, formatConflictWarning } from "../utils/historySearchTool.js";
import { closeAllStateDatabases } from "../state/database.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../../package.json") as { version: string };
const logger = createLogger("MCP");

const server = new McpServer({
  name: "ads-mcp",
  version: packageVersion,
});

type Handler<TInput> = (args: TInput) => Promise<CallToolResult>;

const workspaceParam = z.object({
  workspace_path: z.string().optional(),
});

function asToolResult(text: string, structured?: unknown): CallToolResult {
  const trimmed = text?.trim() ?? "";
  const pretty = trimmed || "(no output)";
  const parsed = structured ?? tryParseJson(trimmed);
  const structuredRecord = asRecord(parsed);
  return {
    content: [
      {
        type: "text",
        text: parsed ? JSON.stringify(parsed, null, 2) : pretty,
      },
    ],
    structuredContent: structuredRecord,
  };
}

function asErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function withHandler<TInput extends z.ZodTypeAny>(schema: TInput, handler: Handler<z.infer<TInput>>) {
  return async (rawArgs: unknown): Promise<CallToolResult> => {
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return asErrorResult(parsed.error.message);
    }
    try {
      return await handler(parsed.data);
    } catch (error) {
      return asErrorResult(error);
    }
  };
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

const searchSchema = z.object({
  query: z.string().min(1, "query is required"),
  max_results: z.number().int().positive().max(10).optional(),
  include_domains: z.array(z.string().min(1)).optional(),
  exclude_domains: z.array(z.string().min(1)).optional(),
  lang: z.string().min(1).optional(),
});

server.registerTool(
  "ads_search",
  {
    title: "Tavily search",
    description: "Perform a web search via Tavily. Returns normalized results and metadata.",
    inputSchema: searchSchema,
  },
  withHandler(searchSchema, async ({ query, max_results, include_domains, exclude_domains, lang }) => {
    const result = await search({
      query,
      maxResults: max_results,
      includeDomains: include_domains,
      excludeDomains: exclude_domains,
      lang,
    });
    return asToolResult(JSON.stringify(result), result);
  })
);

const searchHistorySchema = workspaceParam.extend({
  query: z.string().min(1, "query is required"),
  max_results: z.number().int().positive().max(20).optional(),
});

server.registerTool(
  "ads_search_history",
  {
    title: "Search conversation history",
    description:
      "Search past conversations in the workspace. Use this to recall previous discussions, decisions, or instructions. " +
      "Returns matching results and warns if conflicting instructions are detected. " +
      "You decide when and what to search based on the current task context.",
    inputSchema: searchHistorySchema,
  },
  withHandler(searchHistorySchema, async ({ workspace_path, query, max_results }) => {
    const workspaceRoot = workspace_path ?? process.cwd();
    const result = searchHistoryForAgent({
      workspaceRoot,
      query,
      maxResults: max_results,
    });

    let output = result.results;
    if (result.hasConflicts) {
      output += "\n\n" + formatConflictWarning(result.conflicts);
    }

    return asToolResult(output, {
      found: result.found,
      hasConflicts: result.hasConflicts,
      conflicts: result.conflicts,
    });
  })
);

const transport = new StdioServerTransport();
const KEEP_ALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const keepAliveTimer = setInterval(() => {
  // Periodic no-op to keep the Node.js event loop alive for MCP stdio sessions.
}, KEEP_ALIVE_INTERVAL_MS);

let shuttingDown = false;

server.server.onclose = () => {
  void shutdown(0);
};

server.server.onerror = (error) => {
  logger.error("Transport error", error);
};

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(keepAliveTimer);
  try {
    await server.close();
  } catch (error) {
    logger.error("Error closing server", error);
  }
  try {
    await transport.close();
  } catch (error) {
    logger.error("Error closing transport", error);
  }
  try {
    closeAllStateDatabases();
  } catch {
    // ignore
  }
  process.exit(code);
}

process.once("SIGINT", () => {
  void shutdown(0);
});
process.once("SIGTERM", () => {
  void shutdown(0);
});

async function main(): Promise<void> {
  await server.connect(transport);
  if (process.stdin.isTTY) {
    process.stdin.resume();
  }
}

main().catch((error) => {
  logger.error("Fatal error", error);
  void shutdown(1);
});

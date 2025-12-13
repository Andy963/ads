import { createRequire } from "node:module";

import "../utils/logSink.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createLogger } from "../utils/logger.js";

import {
  listWorkflows,
  getWorkflowStatusSummary,
  listWorkflowLog,
  checkoutWorkflow,
  commitStep,
} from "../workflow/service.js";
import { createWorkflowFromTemplate } from "../workflow/templateService.js";
import { buildAdsHelpMessage } from "../workflow/commands.js";
import { listRules, readRules } from "../workspace/rulesService.js";
import { initWorkspace } from "../workspace/service.js";
import { syncAllNodesToFiles, getWorkspaceInfo as getGraphWorkspaceInfo } from "../graph/service.js";
import { search } from "../tools/search/index.js";

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

const statusSchema = workspaceParam.extend({
  format: z.enum(["cli", "markdown"]).optional(),
});

const initSchema = workspaceParam.extend({
  name: z.string().min(1).optional(),
});

const searchSchema = z.object({
  query: z.string().min(1, "query is required"),
  max_results: z.number().int().positive().max(10).optional(),
  include_domains: z.array(z.string().min(1)).optional(),
  exclude_domains: z.array(z.string().min(1)).optional(),
  lang: z.string().min(1).optional(),
});

server.registerTool(
  "ads_status",
  {
    title: "Get ADS workflow status",
    description: "Retrieve the current workflow status summary for a workspace.",
    inputSchema: statusSchema,
  },
  withHandler(statusSchema, async ({ workspace_path, format }) => {
    const text = await getWorkflowStatusSummary({ workspace_path, format: format ?? "cli" });
    return asToolResult(text);
  })
);

server.registerTool(
  "ads_init",
  {
    title: "Initialize ADS workspace",
    description: "Create .ads workspace metadata, copy default templates, and ensure specs folders exist.",
    inputSchema: initSchema,
  },
  withHandler(initSchema, async ({ workspace_path, name }) => {
    const text = await initWorkspace({ workspace_path, name });
    return asToolResult(text);
  })
);

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

const branchSchema = workspaceParam.extend({
  operation: z.enum(["list", "delete", "force_delete"]).optional(),
  workflow: z.string().optional(),
  format: z.enum(["cli", "markdown"]).optional(),
});

server.registerTool(
  "ads_branch",
  {
    title: "List or delete ADS workflows",
    description: "List workflows or delete workflow context/records in a workspace.",
    inputSchema: branchSchema,
  },
  withHandler(branchSchema, async ({ workspace_path, operation, workflow, format }) => {
    const text = await listWorkflows({ workspace_path, operation, workflow, format });
    return asToolResult(text);
  })
);

const logSchema = workspaceParam.extend({
  limit: z.number().int().positive().max(100).optional(),
  workflow: z.string().optional(),
  format: z.enum(["cli", "markdown"]).optional(),
});

server.registerTool(
  "ads_log",
  {
    title: "Show workflow commit log",
    description: "List recent workflow commits optionally filtered by workflow ID or title.",
    inputSchema: logSchema,
  },
  withHandler(logSchema, async ({ workspace_path, limit, workflow, format }) => {
    const text = await listWorkflowLog({ workspace_path, limit, workflow, format });
    return asToolResult(text);
  })
);

const checkoutSchema = workspaceParam.extend({
  workflow_identifier: z.string(),
  format: z.enum(["cli", "markdown"]).optional(),
});

server.registerTool(
  "ads_checkout",
  {
    title: "Checkout a workflow",
    description: "Switch the active workflow by identifier, title, or index.",
    inputSchema: checkoutSchema,
  },
  withHandler(checkoutSchema, async ({ workspace_path, workflow_identifier, format }) => {
    const text = await checkoutWorkflow({ workspace_path, workflow_identifier, format: format ?? "cli" });
    return asToolResult(text);
  })
);

const newWorkflowSchema = workspaceParam.extend({
  title: z.string().min(1, "title is required"),
  description: z.string().optional(),
  format: z.enum(["cli", "markdown"]).optional(),
});

server.registerTool(
  "ads_new",
  {
    title: "Create a new workflow",
    description: "Generate a workflow using the unified template.",
    inputSchema: newWorkflowSchema,
  },
  withHandler(newWorkflowSchema, async ({ workspace_path, title, description, format }) => {
    const text = await createWorkflowFromTemplate({
      workspace_path,
      title,
      description,
      format: format ?? "cli",
    });
    return asToolResult(text);
  })
);

const commitSchema = workspaceParam.extend({
  step_name: z.string().min(1, "step_name is required"),
  change_description: z.string().optional(),
  format: z.enum(["cli", "markdown"]).optional(),
});

server.registerTool(
  "ads_commit",
  {
    title: "Commit a workflow step",
    description: "Finalize a specified workflow step after approval.",
    inputSchema: commitSchema,
  },
  withHandler(commitSchema, async ({ workspace_path, step_name, change_description, format }) => {
    const text = await commitStep({ workspace_path, step_name, change_description, format: format ?? "cli" });
    return asToolResult(text);
  })
);

server.registerTool(
  "ads_workspace",
  {
    title: "Inspect workspace",
    description: "Return workspace metadata and paths for the current directory.",
    inputSchema: workspaceParam,
  },
  withHandler(workspaceParam, async ({ workspace_path }) => {
    const text = await getGraphWorkspaceInfo({ workspace_path });
    return asToolResult(text);
  })
);

const rulesSchema = workspaceParam.extend({
  category: z.string().optional(),
});

server.registerTool(
  "ads_rules",
  {
    title: "Read workspace rules",
    description: "List project rules or read the full rules document.",
    inputSchema: rulesSchema,
  },
  withHandler(rulesSchema, async ({ workspace_path, category }) => {
    if (category) {
      const text = await listRules({ workspace_path, category });
      return asToolResult(text);
    }
    const text = await readRules(workspace_path);
    return asToolResult(text);
  })
);

server.registerTool(
  "ads_sync",
  {
    title: "Sync graph nodes to files",
    description: "Ensure graph nodes are written to docs/spec directories.",
    inputSchema: workspaceParam,
  },
  withHandler(workspaceParam, async ({ workspace_path }) => {
    const text = await syncAllNodesToFiles({ workspace_path });
    return asToolResult(text);
  })
);

const helpSchema = z.object({});

server.registerTool(
  "ads_help",
  {
    title: "ADS command reference",
    description: "Return the standard ADS command cheat sheet.",
    inputSchema: helpSchema,
  },
  withHandler(helpSchema, async () => {
    const text = buildAdsHelpMessage("cli");
    return asToolResult(text);
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

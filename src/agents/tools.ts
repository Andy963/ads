import type { AgentRunResult } from "./types.js";
import { SearchTool } from "../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../tools/search/config.js";
import { checkTavilySetup } from "../tools/search/setupCodexMcp.js";
import type { SearchParams, SearchResponse } from "../tools/search/types.js";

interface ToolInvocation {
  name: string;
  raw: string;
  payload: string;
}

export interface ToolCallSummary {
  tool: string;
  ok: boolean;
  inputPreview: string;
  outputPreview: string;
}

export interface ToolHooks {
  onInvoke?: (tool: string, payload: string) => void | Promise<void>;
  onResult?: (summary: ToolCallSummary) => void | Promise<void>;
}

export interface ToolResolutionOutcome extends AgentRunResult {
  toolSummaries: ToolCallSummary[];
}

const TOOL_BLOCK_REGEX = /<<<tool\.([a-z0-9_-]+)[\t ]*\n([\s\S]*?)>>>/gi;
const SNIPPET_LIMIT = 180;

function truncate(text: string, limit = SNIPPET_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function extractToolInvocations(text: string): ToolInvocation[] {
  const matches: ToolInvocation[] = [];
  let match: RegExpExecArray | null;
  while ((match = TOOL_BLOCK_REGEX.exec(text)) !== null) {
    matches.push({
      name: (match[1] ?? "").trim().toLowerCase(),
      raw: match[0],
      payload: (match[2] ?? "").trim(),
    });
  }
  return matches;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const normalized = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function parseSearchParams(raw: string): SearchParams {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("搜索指令为空");
  }

  let parsed: unknown = trimmed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Treat as plain query string when JSON parsing fails.
  }

  if (typeof parsed === "string") {
    return { query: parsed.trim() };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("搜索参数需要是纯文本或 JSON 对象");
  }

  const record = parsed as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) {
    throw new Error("搜索参数缺少 query");
  }

  const maxResultsRaw = record.maxResults ?? record.max_results;
  const maxResults =
    typeof maxResultsRaw === "number" && Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
      ? Math.floor(maxResultsRaw)
      : undefined;

  const includeDomains = parseStringArray(record.includeDomains ?? record.include_domains);
  const excludeDomains = parseStringArray(record.excludeDomains ?? record.exclude_domains);
  const lang = typeof record.lang === "string" ? record.lang.trim() : undefined;

  const params: SearchParams = { query };
  if (maxResults) params.maxResults = maxResults;
  if (includeDomains) params.includeDomains = includeDomains;
  if (excludeDomains) params.excludeDomains = excludeDomains;
  if (lang) params.lang = lang;

  return params;
}

function formatSearchResults(query: string, response: SearchResponse): string {
  const lines: string[] = [];
  lines.push(`🔎 搜索：${truncate(query, 96)}`);

  if (response.results.length === 0) {
    lines.push("未找到结果。");
  } else {
    response.results.forEach((item, index) => {
      const title = item.title || "Untitled";
      const url = item.url ? ` ${item.url}` : "";
      const snippet = item.snippet || item.content || "";
      const snippetPart = snippet ? ` - ${truncate(snippet, 140)}` : "";
      lines.push(`${index + 1}. ${title}${url}${snippetPart}`);
    });
  }

  const tookMs = response.meta?.tookMs ?? 0;
  const total = response.meta?.total ?? response.results.length;
  lines.push(`(共 ${total} 条，展示 ${response.results.length} 条，用时 ${tookMs}ms)`);

  return lines.join("\n");
}

async function handleSearchTool(payload: string): Promise<string> {
  const params = parseSearchParams(payload);
  const config = resolveSearchConfig();
  const missingKeys = ensureApiKeys(config);
  if (missingKeys) {
    throw new Error(missingKeys.message);
  }

  const result = await SearchTool.search(params, { config });
  return formatSearchResults(params.query, result);
}

async function runTool(name: string, payload: string): Promise<string> {
  switch (name) {
    case "search":
      return handleSearchTool(payload);
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

export function injectToolGuide(input: string): string {
  // 如果 Codex 已配置 Tavily MCP，不需要注入文本协议指南
  // 模型会通过原生工具调用使用搜索
  const mcpStatus = checkTavilySetup();
  if (mcpStatus.configured) {
    return input;
  }

  // 检查是否有 API keys（备用的文本协议方式）
  const searchEnabled = !ensureApiKeys(resolveSearchConfig());
  if (!searchEnabled) {
    return input;
  }

  // 旧的文本协议方式（不推荐，仅作为备用）
  // 注意：这种方式可能不被模型识别，建议配置 Codex MCP
  const guide = [
    "【可用工具 - 备用方式，建议配置 Codex MCP】",
    "search - 调用 Tavily 搜索，格式：",
    "<<<tool.search",
    '{"query":"关键词","maxResults":5,"lang":"en"}',
    ">>>",
    "注意：推荐运行 `npx ts-node src/tools/search/setupCodexMcp.ts setup` 配置原生 MCP 支持。",
  ].join("\n");

  return `${input}\n\n${guide}`;
}

export async function resolveToolInvocations(
  result: AgentRunResult,
  hooks?: ToolHooks,
): Promise<ToolResolutionOutcome> {
  const invocations = extractToolInvocations(result.response);
  if (invocations.length === 0) {
    return { ...result, toolSummaries: [] };
  }

  let resolvedText = result.response;
  const summaries: ToolCallSummary[] = [];

  for (const invocation of invocations) {
    await hooks?.onInvoke?.(invocation.name, invocation.payload);
    try {
      const output = await runTool(invocation.name, invocation.payload);
      resolvedText = resolvedText.replace(invocation.raw, output);
      const summary: ToolCallSummary = {
        tool: invocation.name,
        ok: true,
        inputPreview: truncate(invocation.payload),
        outputPreview: truncate(output),
      };
      summaries.push(summary);
      await hooks?.onResult?.(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = `⚠️ 工具 ${invocation.name} 失败：${message}`;
      resolvedText = resolvedText.replace(invocation.raw, fallback);
      const summary: ToolCallSummary = {
        tool: invocation.name,
        ok: false,
        inputPreview: truncate(invocation.payload),
        outputPreview: truncate(fallback),
      };
      summaries.push(summary);
      await hooks?.onResult?.(summary);
    }
  }

  return {
    response: resolvedText,
    usage: result.usage,
    agentId: result.agentId,
    toolSummaries: summaries,
  };
}

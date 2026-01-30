import path from "node:path";

import type { AgentRunResult } from "./types.js";
import { SearchTool } from "../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../tools/search/config.js";
import { checkTavilySetup } from "../tools/search/setupCodexMcp.js";
import type { SearchParams } from "../tools/search/types.js";
import { formatSearchResults } from "../tools/search/format.js";
import { runVectorSearch } from "../vectorSearch/run.js";
import { loadVectorSearchConfig } from "../vectorSearch/config.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";
import { getExecAllowlistFromEnv, runCommand } from "../utils/commandRunner.js";
import { runFindTool, runGrepTool } from "./tools/fileSearch.js";
import { runApplyPatchTool, runReadTool, runWriteTool } from "./tools/fileIo.js";
import { resolveBaseDir, type ToolExecutionContext } from "./tools/context.js";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_OUTPUT_BYTES,
  createAbortError,
  isAbortError,
  isApplyPatchEnabled,
  isExecToolEnabled,
  isFileToolsEnabled,
  logger,
  throwIfAborted,
  truncate,
} from "./tools/shared.js";

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

export interface ToolExecutionResult {
  tool: string;
  payload: string;
  ok: boolean;
  output: string;
  error?: string;
}

export interface ToolHooks {
  onInvoke?: (tool: string, payload: string) => void | Promise<void>;
  onResult?: (summary: ToolCallSummary) => void | Promise<void>;
}

export interface ToolResolutionOutcome extends AgentRunResult {
  toolSummaries: ToolCallSummary[];
}

const TOOL_BLOCK_REGEX = /<<<tool\.([a-z0-9_-]+)[\t ]*\r?\n([\s\S]*?)>>>/gi;
const PARALLEL_TOOL_NAMES = new Set(["read", "grep", "find", "search", "vsearch"]);
const PARALLEL_TOOL_CONCURRENCY = 6;

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    (async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          break;
        }
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
      }
    })(),
  );

  await Promise.all(runners);
  return results;
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

export function stripToolBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const regex = new RegExp(TOOL_BLOCK_REGEX.source, TOOL_BLOCK_REGEX.flags);
  const stripped = text.replace(regex, "").trim();
  return stripped.replace(/\n{3,}/g, "\n\n");
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

async function handleVectorSearchTool(payload: string, context: ToolExecutionContext): Promise<string> {
  const query = payload.trim();
  if (!query) {
    throw new Error("vsearch 需要提供查询字符串");
  }
  const workspaceRoot = detectWorkspaceFrom(context.cwd || process.cwd());
  return runVectorSearch({
    workspaceRoot,
    query,
    entryNamespace: "agent",
  });
}

async function runAgentTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!context.invokeAgent) {
    throw new Error("当前上下文不支持调用协作代理");
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const agentIdRaw = record?.agentId ?? record?.agent_id ?? record?.agent;
    const promptRaw = record?.prompt ?? record?.input ?? record?.query;

    const agentId = String(agentIdRaw ?? "").trim().toLowerCase();
    const prompt =
      typeof promptRaw === "string"
        ? promptRaw
        : promptRaw && typeof promptRaw === "object"
          ? JSON.stringify(promptRaw)
          : String(promptRaw ?? "");

    if (!agentId || !prompt.trim()) {
      throw new Error("agent 工具需要 agentId 和 prompt 参数");
    }
    return await context.invokeAgent(agentId, prompt);
  } catch (error) {
    if (error instanceof Error && error.message.includes("agent 工具需要")) {
      throw error;
    }
    // Fallback to raw payload as prompt if not JSON
    const lines = payload.trim().split("\n");
    const firstLine = lines[0].trim();
    const agentId = firstLine.toLowerCase();
    const prompt = lines.slice(1).join("\n").trim();
    if (!agentId || !prompt) {
      throw new Error("agent 工具格式错误。请使用 JSON 或首行 agentId 后跟 prompt。");
    }
    return await context.invokeAgent(agentId, prompt);
  }
}

function splitCommandLine(commandLine: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (const ch of commandLine.trim()) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();

  const cmd = tokens.shift() ?? "";
  return { cmd, args: tokens };
}

function parseExecPayload(payload: string): {
  cmd: string;
  args: string[];
  timeoutMs: number;
} {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("exec payload 为空");
  }

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("exec payload JSON 解析失败", { cause: error instanceof Error ? error : undefined });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("exec payload 必须是 JSON 对象");
    }
    const record = parsed as Record<string, unknown>;
    const cmdRaw = record.cmd ?? record.command;
    const cmd = typeof cmdRaw === "string" ? cmdRaw.trim() : "";
    if (!cmd) {
      throw new Error("exec payload 缺少 cmd/command");
    }
    const argsRaw = record.args ?? record.argv;
    const args = Array.isArray(argsRaw)
      ? argsRaw.map((entry) => String(entry))
      : typeof argsRaw === "string"
        ? splitCommandLine(argsRaw).args
        : [];
    const timeoutRaw = record.timeoutMs ?? record.timeout_ms;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : EXEC_DEFAULT_TIMEOUT_MS;
    return { cmd, args, timeoutMs };
  }

  const { cmd, args } = splitCommandLine(trimmed);
  if (!cmd) {
    throw new Error("exec payload 缺少命令");
  }
  return { cmd, args, timeoutMs: EXEC_DEFAULT_TIMEOUT_MS };
}

async function runExecTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isExecToolEnabled()) {
    throw new Error("exec 工具已禁用（设置 ENABLE_AGENT_EXEC_TOOL=1 重新启用）");
  }
  throwIfAborted(context.signal);

  const { cmd: rawCmd, args, timeoutMs } = parseExecPayload(payload);
  const cwd = resolveBaseDir(context);
  const executable = path.basename(rawCmd).toLowerCase();
  const allowlist = getExecAllowlistFromEnv();
  if (allowlist && !allowlist.includes(executable)) {
    throw new Error(`不允许执行命令: ${executable}（可用 AGENT_EXEC_TOOL_ALLOWLIST 配置白名单；'*' 表示不限制）`);
  }

  const command = await runCommand({
    cmd: rawCmd,
    args,
    cwd,
    timeoutMs,
    env: process.env,
    signal: context.signal,
    maxOutputBytes: EXEC_MAX_OUTPUT_BYTES,
    allowlist,
  });

  logger.info(`[tool.exec] cwd=${cwd} cmd=${command.commandLine}`);

  const lines: string[] = [];
  lines.push(`$ ${command.commandLine}`);
  if (command.timedOut) {
    lines.push(`⏱️ timeout after ${timeoutMs}ms`);
  }
  lines.push(`exit=${command.exitCode ?? "null"} signal=${command.signal ?? "null"} elapsed=${command.elapsedMs}ms`);

  if (command.stdout) {
    lines.push("");
    lines.push("stdout:");
    lines.push("```");
    lines.push(command.stdout + (command.truncatedStdout ? "\n…(truncated)" : ""));
    lines.push("```");
  }
  if (command.stderr) {
    lines.push("");
    lines.push("stderr:");
    lines.push("```");
    lines.push(command.stderr + (command.truncatedStderr ? "\n…(truncated)" : ""));
    lines.push("```");
  }

  return lines.join("\n").trim();
}

async function runTool(name: string, payload: string, context: ToolExecutionContext): Promise<string> {
  throwIfAborted(context.signal);
  switch (name) {
    case "search":
      return handleSearchTool(payload);
    case "vsearch":
      return handleVectorSearchTool(payload, context);
    case "agent":
      return runAgentTool(payload, context);
    case "exec":
      return runExecTool(payload, context);
    case "read":
      return runReadTool(payload, context);
    case "write":
      return runWriteTool(payload, context);
    case "apply_patch":
      return runApplyPatchTool(payload, context);
    case "grep":
      return runGrepTool(payload, context);
    case "find":
      return runFindTool(payload, context);
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

export async function executeToolInvocation(
  tool: string,
  payload: string,
  context: ToolExecutionContext = {},
  hooks?: ToolHooks,
): Promise<ToolExecutionResult> {
  throwIfAborted(context.signal);
  await hooks?.onInvoke?.(tool, payload);
  try {
    throwIfAborted(context.signal);
    const output = await runTool(tool, payload, context);
    const result: ToolExecutionResult = { tool, payload, ok: true, output };
    const summary: ToolCallSummary = {
      tool,
      ok: true,
      inputPreview: truncate(payload),
      outputPreview: truncate(output),
    };
    await hooks?.onResult?.(summary);
    return result;
  } catch (error) {
    if (context.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : createAbortError();
    }
    const message = error instanceof Error ? error.message : String(error);
    const output = `⚠️ 工具 ${tool} 失败：${message}`;
    const result: ToolExecutionResult = { tool, payload, ok: false, output, error: message };
    const summary: ToolCallSummary = {
      tool,
      ok: false,
      inputPreview: truncate(payload),
      outputPreview: truncate(output),
    };
    await hooks?.onResult?.(summary);
    return result;
  }
}

export async function executeToolBlocks(
  text: string,
  hooks?: ToolHooks,
  context: ToolExecutionContext = {},
): Promise<{ replacedText: string; strippedText: string; results: ToolExecutionResult[]; summaries: ToolCallSummary[] }> {
  const invocations = extractToolInvocations(text);
  if (invocations.length === 0) {
    return { replacedText: text, strippedText: text, results: [], summaries: [] };
  }

  const executeInvocation = async (
    invocation: ToolInvocation,
  ): Promise<{ invocation: ToolInvocation; result: ToolExecutionResult; summary: ToolCallSummary }> => {
    throwIfAborted(context.signal);
    try {
      throwIfAborted(context.signal);
      const output = await runTool(invocation.name, invocation.payload, context);
      return {
        invocation,
        result: { tool: invocation.name, payload: invocation.payload, ok: true, output },
        summary: {
          tool: invocation.name,
          ok: true,
          inputPreview: truncate(invocation.payload),
          outputPreview: truncate(output),
        },
      };
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) {
        throw error instanceof Error ? error : createAbortError();
      }
      const message = error instanceof Error ? error.message : String(error);
      const fallback = `⚠️ 工具 ${invocation.name} 失败：${message}`;
      return {
        invocation,
        result: {
          tool: invocation.name,
          payload: invocation.payload,
          ok: false,
          output: fallback,
          error: message,
        },
        summary: {
          tool: invocation.name,
          ok: false,
          inputPreview: truncate(invocation.payload),
          outputPreview: truncate(fallback),
        },
      };
    }
  };

  const results: ToolExecutionResult[] = [];
  const summaries: ToolCallSummary[] = [];
  let replacedText = text;

  let idx = 0;
  while (idx < invocations.length) {
    const current = invocations[idx]!;

    if (!PARALLEL_TOOL_NAMES.has(current.name)) {
      throwIfAborted(context.signal);
      await hooks?.onInvoke?.(current.name, current.payload);
      const item = await executeInvocation(current);
      replacedText = replacedText.replace(item.invocation.raw, item.result.output);
      results.push(item.result);
      summaries.push(item.summary);
      await hooks?.onResult?.(item.summary);
      idx += 1;
      continue;
    }

    const batch: ToolInvocation[] = [];
    while (idx < invocations.length && PARALLEL_TOOL_NAMES.has(invocations[idx]!.name)) {
      batch.push(invocations[idx]!);
      idx += 1;
    }

    for (const invocation of batch) {
      throwIfAborted(context.signal);
      await hooks?.onInvoke?.(invocation.name, invocation.payload);
    }

    const batchResults = await runWithConcurrency(batch, PARALLEL_TOOL_CONCURRENCY, (invocation) =>
      executeInvocation(invocation),
    );
    for (const item of batchResults) {
      replacedText = replacedText.replace(item.invocation.raw, item.result.output);
      results.push(item.result);
      summaries.push(item.summary);
      await hooks?.onResult?.(item.summary);
    }
  }

  return { replacedText, strippedText: stripToolBlocks(text), results, summaries };
}

export function injectToolGuide(
  input: string,
  options?: {
    activeAgentId?: string;
    invokeAgentEnabled?: boolean;
  },
): string {
  const activeAgentId = options?.activeAgentId ?? "codex";
  const usesToolBlocks = true;
  const wantsSearchGuide = () => {
    const searchEnabled = !ensureApiKeys(resolveSearchConfig());
    if (!searchEnabled) {
      return false;
    }
    if (activeAgentId !== "codex") {
      return true;
    }
    const mcpStatus = checkTavilySetup();
    return !mcpStatus.configured;
  };

  const wantsVectorSearchGuide = () => {
    const { config } = loadVectorSearchConfig();
    return !!config?.enabled;
  };

  const guideLines: string[] = [];

  if (usesToolBlocks && wantsSearchGuide()) {
    guideLines.push(
      [
        "【可用工具】",
        "search - 调用 Tavily 搜索，格式：",
        "<<<tool.search",
        '{"query":"关键词","maxResults":5,"lang":"en"}',
        ">>>",
      ].join("\n"),
    );
  }

  if (usesToolBlocks && wantsVectorSearchGuide()) {
    guideLines.push(
      [
        "【可用工具】",
        "vsearch - 调用本地向量搜索（语义搜索），可检索 Spec 文档、ADR 和历史对话，格式：",
        "建议：当你需要回忆/引用已有 Spec、ADR 或历史对话里的信息时，先用 vsearch 检索再回答。",
        "<<<tool.vsearch",
        "如何实现用户认证？",
        ">>>",
      ].join("\n"),
    );
  }

  if (usesToolBlocks && options?.invokeAgentEnabled) {
    guideLines.push(
      [
        "agent - 调用协作代理协助处理子任务，格式：",
        "<<<tool.agent",
        '{"agentId":"codex","prompt":"请帮我处理这个子任务..."}',
        ">>>",
      ].join("\n"),
    );
  }

  if (usesToolBlocks && activeAgentId !== "codex" && isFileToolsEnabled()) {
    guideLines.push(
      [
        "read - 读取本地文件（默认启用；可用 ENABLE_AGENT_FILE_TOOLS=0 禁用；受目录白名单限制），格式：",
        "<<<tool.read",
        '{"path":"src/index.ts","startLine":1,"endLine":120}',
        ">>>",
        "write - 写入本地文件（默认启用；可用 ENABLE_AGENT_FILE_TOOLS=0 禁用；受目录白名单限制），格式：",
        "<<<tool.write",
        '{"path":"src/example.txt","content":"hello"}',
        ">>>",
      ].join("\n"),
    );
    if (isApplyPatchEnabled()) {
      guideLines.push(
        [
          "apply_patch - 通过 unified diff 应用补丁（默认启用；可用 ENABLE_AGENT_APPLY_PATCH=0 禁用；需要 git；受目录白名单限制），格式：",
          "<<<tool.apply_patch",
          "diff --git a/src/a.ts b/src/a.ts",
          "index 0000000..1111111 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new",
          ">>>",
        ].join("\n"),
      );
    }
  }

  if (usesToolBlocks && activeAgentId !== "codex" && isExecToolEnabled()) {
    guideLines.push(
      [
        "exec - 在本机执行命令（默认启用；可用 ENABLE_AGENT_EXEC_TOOL=0 禁用；可选用 AGENT_EXEC_TOOL_ALLOWLIST 限制命令，'*' 表示不限制），格式：",
        "<<<tool.exec",
        "npm test",
        ">>>",
        "（可选 JSON）",
        "<<<tool.exec",
        '{"cmd":"npm","args":["run","build"],"timeoutMs":600000}',
        ">>>",
      ].join("\n"),
    );
  }

  const guide = guideLines.filter(Boolean).join("\n\n").trim();
  if (!guide) {
    return input;
  }
  return `${input}\n\n${guide}`;
}

export async function resolveToolInvocations(
  result: AgentRunResult,
  hooks?: ToolHooks,
  context: ToolExecutionContext = {},
): Promise<ToolResolutionOutcome> {
  const outcome = await executeToolBlocks(result.response, hooks, context);

  return {
    response: outcome.replacedText,
    usage: result.usage,
    agentId: result.agentId,
    toolSummaries: outcome.summaries,
  };
}

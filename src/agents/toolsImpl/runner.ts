import path from "node:path";

import { SearchTool } from "../../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../../tools/search/config.js";
import type { SearchParams } from "../../tools/search/types.js";
import { formatSearchResults } from "../../tools/search/format.js";
import { runVectorSearch } from "../../vectorSearch/run.js";
import { detectWorkspaceFrom } from "../../workspace/detector.js";
import { getExecAllowlistFromEnv, runCommand } from "../../utils/commandRunner.js";
import { runFindTool, runGrepTool } from "../tools/fileSearch.js";
import { runApplyPatchTool, runReadTool, runWriteTool } from "../tools/fileIo.js";
import { resolveBaseDir, type ToolExecutionContext } from "../tools/context.js";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_OUTPUT_BYTES,
  createAbortError,
  isAbortError,
  isExecToolEnabled,
  logger,
  throwIfAborted,
  truncate,
} from "../tools/shared.js";

import type { ToolCallSummary, ToolExecutionResult, ToolHooks } from "./types.js";

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
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
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

function parseExecPayload(payload: string): { cmd: string; args: string[]; timeoutMs: number } {
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

export async function runTool(name: string, payload: string, context: ToolExecutionContext): Promise<string> {
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


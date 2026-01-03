import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { AgentRunResult } from "./types.js";
import { SearchTool } from "../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../tools/search/config.js";
import { checkTavilySetup } from "../tools/search/setupCodexMcp.js";
import type { SearchParams } from "../tools/search/types.js";
import { formatSearchResults } from "../tools/search/format.js";
import { createLogger } from "../utils/logger.js";
import { runVectorSearch } from "../vectorSearch/run.js";
import { loadVectorSearchConfig } from "../vectorSearch/config.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";
import { getExecAllowlistFromEnv, runCommand } from "../utils/commandRunner.js";

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

const TOOL_BLOCK_REGEX = /<<<tool\.([a-z0-9_-]+)[\t ]*\n([\s\S]*?)>>>/gi;
const SNIPPET_LIMIT = 180;
const EXEC_MAX_OUTPUT_BYTES = 48 * 1024;
const EXEC_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_DEFAULT_MAX_BYTES = 200 * 1024;
const FILE_DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;
const PATCH_DEFAULT_MAX_BYTES = 512 * 1024;

const logger = createLogger("AgentTools");
const PARALLEL_TOOL_NAMES = new Set(["read", "grep", "find", "search", "vsearch"]);

function createAbortError(message = "用户中断了请求"): Error {
  const abortError = new Error(message);
  abortError.name = "AbortError";
  return abortError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function truncate(text: string, limit = SNIPPET_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isExecToolEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_EXEC_TOOL, true);
}

function isFileToolsEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_FILE_TOOLS, true);
}

function isApplyPatchEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_APPLY_PATCH, true);
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function getReadMaxBytes(): number {
  return parsePositiveInt(process.env.AGENT_FILE_TOOL_MAX_BYTES, FILE_DEFAULT_MAX_BYTES);
}

function getWriteMaxBytes(): number {
  return parsePositiveInt(process.env.AGENT_FILE_TOOL_MAX_WRITE_BYTES, FILE_DEFAULT_MAX_WRITE_BYTES);
}

function getPatchMaxBytes(): number {
  return parsePositiveInt(process.env.AGENT_APPLY_PATCH_MAX_BYTES, PATCH_DEFAULT_MAX_BYTES);
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
    const parsed = JSON.parse(payload);
    const agentId = parsed.agentId || parsed.agent_id || parsed.agent;
    const prompt = parsed.prompt || parsed.input || parsed.query;
    if (!agentId || !prompt) {
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
    const agentId = firstLine;
    const prompt = lines.slice(1).join("\n").trim();
    if (!agentId || !prompt) {
      throw new Error("agent 工具格式错误。请使用 JSON 或首行 agentId 后跟 prompt。");
    }
    return await context.invokeAgent(agentId, prompt);
  }
}

export interface ToolExecutionContext {
  cwd?: string;
  allowedDirs?: string[];
  signal?: AbortSignal;
  invokeAgent?: (agentId: string, prompt: string) => Promise<string>;
  historyNamespace?: string;
  historySessionId?: string;
}

function resolveBaseDir(context: ToolExecutionContext): string {
  const cwd = context.cwd ? path.resolve(context.cwd) : process.cwd();
  if (!fs.existsSync(cwd)) {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) {
    throw new Error(`工作目录不是文件夹: ${cwd}`);
  }
  if (context.allowedDirs && context.allowedDirs.length > 0) {
    const resolvedAllowed = context.allowedDirs.map((dir) => path.resolve(dir));
    const ok = resolvedAllowed.some((dir) => {
      const rel = path.relative(dir, cwd);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!ok) {
      throw new Error(`工作目录不在白名单内: ${cwd}`);
    }
  }
  return cwd;
}

function isWithinAllowedDirs(targetPath: string, allowedDirs: string[] | undefined): boolean {
  if (!allowedDirs || allowedDirs.length === 0) {
    return true;
  }
  const resolvedAllowed = allowedDirs.map((dir) => path.resolve(dir));
  return resolvedAllowed.some((dir) => {
    const rel = path.relative(dir, targetPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

function resolvePathForTool(targetPath: string, context: ToolExecutionContext): string {
  const baseDir = resolveBaseDir(context);
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(baseDir, targetPath);
  if (!isWithinAllowedDirs(resolved, context.allowedDirs)) {
    throw new Error(`路径不在白名单内: ${resolved}`);
  }
  return resolved;
}

function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const marker = path.join(current, ".git");
    if (fs.existsSync(marker)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
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

interface ReadToolRequest {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

function parseReadToolRequests(payload: string): ReadToolRequest[] {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("read payload 为空");
  }

  let parsed: unknown = trimmed;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("read payload JSON 解析失败", { cause: error instanceof Error ? error : undefined });
    }
  }

  if (typeof parsed === "string") {
    return [{ path: parsed.trim() }];
  }

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      if (typeof entry === "string") {
        const requestPath = entry.trim();
        if (!requestPath) {
          throw new Error("read payload 包含空 path");
        }
        return { path: requestPath };
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("read payload 数组元素必须是 string 或对象");
      }
      const record = entry as Record<string, unknown>;
      const requestPath = typeof record.path === "string" ? record.path.trim() : "";
      if (!requestPath) {
        throw new Error("read payload 缺少 path");
      }
      const startLineRaw = record.startLine ?? record.start_line;
      const endLineRaw = record.endLine ?? record.end_line;
      const maxBytesRaw = record.maxBytes ?? record.max_bytes;
      const startLine =
        typeof startLineRaw === "number" && Number.isFinite(startLineRaw) && startLineRaw > 0
          ? Math.floor(startLineRaw)
          : undefined;
      const endLine =
        typeof endLineRaw === "number" && Number.isFinite(endLineRaw) && endLineRaw > 0
          ? Math.floor(endLineRaw)
          : undefined;
      const maxBytes =
        typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
          ? Math.floor(maxBytesRaw)
          : undefined;
      return { path: requestPath, startLine, endLine, maxBytes };
    });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("read payload 必须是文件路径或 JSON");
  }

  const record = parsed as Record<string, unknown>;
  const pathsRaw = record.paths ?? record.files;
  if (Array.isArray(pathsRaw)) {
    const requests: ReadToolRequest[] = [];
    for (const entry of pathsRaw) {
      if (typeof entry !== "string") {
        continue;
      }
      const requestPath = entry.trim();
      if (requestPath) {
        requests.push({ path: requestPath });
      }
    }
    if (requests.length > 0) {
      return requests;
    }
  }

  const requestPath = typeof record.path === "string" ? record.path.trim() : "";
  if (!requestPath) {
    throw new Error("read payload 缺少 path");
  }

  const startLineRaw = record.startLine ?? record.start_line;
  const endLineRaw = record.endLine ?? record.end_line;
  const maxBytesRaw = record.maxBytes ?? record.max_bytes;
  const startLine =
    typeof startLineRaw === "number" && Number.isFinite(startLineRaw) && startLineRaw > 0
      ? Math.floor(startLineRaw)
      : undefined;
  const endLine =
    typeof endLineRaw === "number" && Number.isFinite(endLineRaw) && endLineRaw > 0
      ? Math.floor(endLineRaw)
      : undefined;
  const maxBytes =
    typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
      ? Math.floor(maxBytesRaw)
      : undefined;

  return [{ path: requestPath, startLine, endLine, maxBytes }];
}

function formatReadToolOutput(
  relativeHint: string,
  content: string,
  truncated: boolean,
  request?: { startLine?: number; endLine?: number },
): string {
  const rangePart =
    request?.startLine || request?.endLine
      ? ` (lines ${request.startLine ?? 1}-${request.endLine ?? "end"})`
      : "";
  const truncPart = truncated ? "\n…(truncated)" : "";
  return [
    `📄 ${relativeHint}${rangePart}`,
    "```",
    content.trimEnd() + truncPart,
    "```",
  ].join("\n");
}

async function runReadTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }

  const baseDir = resolveBaseDir(context);
  const defaultMaxBytes = getReadMaxBytes();
  const requests = parseReadToolRequests(payload);
  if (requests.length === 0) {
    throw new Error("read payload 为空");
  }

  const outputs: string[] = [];
  for (const request of requests) {
    const maxBytes = request.maxBytes ?? defaultMaxBytes;
    const absolutePath = resolvePathForTool(request.path, { ...context, cwd: baseDir });
    const relativeHint = path.relative(baseDir, absolutePath) || path.basename(absolutePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`文件不存在: ${relativeHint}`);
    }
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`不是文件: ${relativeHint}`);
    }

    const fd = fs.openSync(absolutePath, "r");
    let bytesRead = 0;
    let truncated = false;
    try {
      const buf = Buffer.alloc(maxBytes);
      bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
      truncated = stat.size > bytesRead;
      const slice = buf.subarray(0, bytesRead);
      if (slice.includes(0)) {
        throw new Error(`疑似二进制文件，拒绝读取: ${relativeHint}`);
      }
      let text = slice.toString("utf8");
      if (request.startLine || request.endLine) {
        const start = Math.max(1, request.startLine ?? 1);
        const lines = text.split(/\r?\n/);
        const end = Math.max(start, request.endLine ?? lines.length);
        text = lines.slice(start - 1, end).join("\n");
      }
      outputs.push(formatReadToolOutput(relativeHint, text, truncated, request));
    } finally {
      try {
        fs.closeSync(fd);
      } catch (error) {
        logger.warn(`[tool.read] Failed to close file: ${absolutePath}`, error);
      }
    }
  }

  return outputs.join("\n\n").trim();
}

function parseWritePayload(payload: string): { path: string; content: string; append: boolean } {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("write payload 为空");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error("write payload 必须是 JSON 对象", { cause: error instanceof Error ? error : undefined });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("write payload 必须是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  const filePath = typeof record.path === "string" ? record.path.trim() : "";
  if (!filePath) {
    throw new Error("write payload 缺少 path");
  }
  const contentValue = record.content ?? record.text;
  if (typeof contentValue !== "string") {
    throw new Error("write payload 缺少 content");
  }
  const content = contentValue;
  const append = Boolean(record.append);
  return { path: filePath, content, append };
}

async function runWriteTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }

  const baseDir = resolveBaseDir(context);
  const { path: targetPath, content, append } = parseWritePayload(payload);
  const maxBytes = getWriteMaxBytes();
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`write 内容过大 (${bytes} bytes)，超过限制 ${maxBytes} bytes`);
  }

  const absolutePath = resolvePathForTool(targetPath, { ...context, cwd: baseDir });
  const relativeHint = path.relative(baseDir, absolutePath) || path.basename(absolutePath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (append) {
    fs.appendFileSync(absolutePath, content, "utf8");
  } else {
    fs.writeFileSync(absolutePath, content, "utf8");
  }

  logger.info(`[tool.write] ${append ? "append" : "write"} ${relativeHint} (${bytes} bytes)`);
  return `✅ 已写入 ${relativeHint} (${bytes} bytes)`;
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (!match) continue;
    const aPath = match[1];
    const bPath = match[2];
    if (aPath && aPath !== "/dev/null") paths.add(aPath);
    if (bPath && bPath !== "/dev/null") paths.add(bPath);
  }
  if (paths.size === 0) {
    for (const line of lines) {
      const header = line.match(/^(---|\+\+\+) (.+)$/);
      if (!header) continue;
      const fileToken = header[2].trim();
      if (fileToken === "/dev/null") continue;
      const normalized = fileToken.replace(/^([ab])\//, "");
      if (normalized) {
        paths.add(normalized);
      }
    }
  }
  return Array.from(paths);
}

function validatePatchPaths(paths: string[], context: ToolExecutionContext): void {
  const baseDir = resolveBaseDir(context);
  for (const rawPath of paths) {
    const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
    if (!normalized || normalized === "." || normalized === "/") {
      throw new Error(`patch 路径无效: ${rawPath}`);
    }
    if (normalized.includes("\0")) {
      throw new Error(`patch 路径包含非法字符: ${rawPath}`);
    }
    if (normalized.startsWith("/")) {
      throw new Error(`patch 路径不安全: ${rawPath}`);
    }
    const absolute = path.resolve(baseDir, normalized);
    if (!isWithinAllowedDirs(absolute, context.allowedDirs)) {
      throw new Error(`patch 修改路径不在白名单内: ${normalized}`);
    }
  }
}

async function runApplyPatchTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }
  if (!isApplyPatchEnabled()) {
    throw new Error("apply_patch 工具已禁用（设置 ENABLE_AGENT_APPLY_PATCH=1 重新启用）");
  }
  throwIfAborted(context.signal);

  let patchText = payload.replaceAll("\r\n", "\n");
  const lines = patchText.split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  patchText = lines.join("\n");
  if (!patchText) {
    throw new Error("apply_patch payload 为空");
  }
  if (!patchText.endsWith("\n")) {
    patchText += "\n";
  }
  const patchBytes = Buffer.byteLength(patchText, "utf8");
  const maxBytes = getPatchMaxBytes();
  if (patchBytes > maxBytes) {
    throw new Error(`patch 过大 (${patchBytes} bytes)，超过限制 ${maxBytes} bytes`);
  }

  const cwd = resolveBaseDir(context);
  const patchPaths = extractPatchPaths(patchText);
  if (patchPaths.length > 0) {
    validatePatchPaths(patchPaths, { ...context, cwd });
  }

  logger.info(`[tool.apply_patch] cwd=${cwd} bytes=${patchBytes} files=${patchPaths.length}`);

  return await new Promise<string>((resolve, reject) => {
    const signal = context.signal;
    const gitRoot = findGitRoot(cwd);
    const prefixRaw = gitRoot ? path.relative(gitRoot, cwd) : "";
    const prefix = prefixRaw && prefixRaw !== "." ? prefixRaw.split(path.sep).join("/") : "";
    const args = ["apply", "--whitespace=nowarn"];
    if (prefix) {
      args.push(`--directory=${prefix}`);
    }
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let settled = false;

    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const append = (key: "stdout" | "stderr", chunk: Buffer<ArrayBufferLike>) => {
      const current = buffers[key];
      const next = Buffer.concat([current, chunk]);
      buffers[key] = next.length > EXEC_MAX_OUTPUT_BYTES ? next.subarray(0, EXEC_MAX_OUTPUT_BYTES) : next;
    };

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      cleanup();
      reject(createAbortError());
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => append("stderr", chunk));
    child.on("error", (error) => {
      cleanup();
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        const filesPart = patchPaths.length > 0 ? ` files=${patchPaths.join(", ")}` : "";
        resolve(`✅ Patch applied.${filesPart}`);
        return;
      }
      const stderrText = buffers.stderr.toString("utf8").trim();
      const stdoutText = buffers.stdout.toString("utf8").trim();
      const detail = stderrText || stdoutText || `git apply exited with code ${code ?? "null"}`;
      reject(new Error(detail));
    });

    child.stdin?.write(patchText);
    child.stdin?.end();
  });
}

const GREP_DEFAULT_MAX_RESULTS = 50;
const FIND_DEFAULT_MAX_RESULTS = 50;

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

function parseGrepPayload(payload: string): GrepParams {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("grep payload 为空");
  }

  let parsed: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Treat as plain pattern if not valid JSON
    }
  }

  if (typeof parsed === "string") {
    return { pattern: parsed.trim() };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("grep payload 必须是 pattern 字符串或 JSON 对象");
  }

  const record = parsed as Record<string, unknown>;
  const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
  if (!pattern) {
    throw new Error("grep payload 缺少 pattern");
  }

  return {
    pattern,
    path: typeof record.path === "string" ? record.path.trim() : undefined,
    glob: typeof record.glob === "string" ? record.glob.trim() : undefined,
    ignoreCase: typeof record.ignoreCase === "boolean" ? record.ignoreCase : undefined,
    maxResults: typeof record.maxResults === "number" && record.maxResults > 0
      ? Math.floor(record.maxResults)
      : undefined,
  };
}

async function runGrepTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }
  throwIfAborted(context.signal);

  const params = parseGrepPayload(payload);
  const cwd = resolveBaseDir(context);
  const searchPath = params.path
    ? resolvePathForTool(params.path, context)
    : cwd;

  const maxResults = params.maxResults ?? GREP_DEFAULT_MAX_RESULTS;
  const args = ["--no-heading", "--line-number", "--color=never"];

  if (params.ignoreCase) {
    args.push("--ignore-case");
  }
  if (params.glob) {
    args.push("--glob", params.glob);
  }
  args.push("--max-count", String(maxResults * 2)); // Get more to account for context
  args.push("--", params.pattern, searchPath);

  logger.info(`[tool.grep] cwd=${cwd} pattern=${params.pattern} path=${searchPath}`);

  return await new Promise<string>((resolve, reject) => {
    const signal = context.signal;
    const child = spawn("rg", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(createAbortError());
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < EXEC_MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < EXEC_MAX_OUTPUT_BYTES) {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      // If ripgrep is not installed, suggest using exec with grep
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ripgrep (rg) 未安装。请使用 exec 工具执行 grep 命令。"));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      const outText = stdout.toString("utf8").trim();
      const errText = stderr.toString("utf8").trim();

      // rg returns 1 when no matches found, 2 on error
      if (code === 1 && !errText) {
        resolve(`🔍 grep: "${params.pattern}" - 未找到匹配`);
        return;
      }
      if (code !== 0 && code !== 1) {
        reject(new Error(errText || `rg exited with code ${code}`));
        return;
      }

      const lines = outText.split("\n").filter(Boolean);
      const truncated = lines.length > maxResults;
      const displayLines = lines.slice(0, maxResults);

      const result = [
        `🔍 grep: "${params.pattern}" (${lines.length} matches${truncated ? ", showing " + maxResults : ""})`,
        "",
        ...displayLines,
        truncated ? `\n…(${lines.length - maxResults} more matches)` : "",
      ].filter(Boolean).join("\n");

      resolve(result);
    });
  });
}

interface FindParams {
  pattern: string;
  path?: string;
  maxResults?: number;
}

function parseFindPayload(payload: string): FindParams {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("find payload 为空");
  }

  let parsed: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Treat as plain pattern if not valid JSON
    }
  }

  if (typeof parsed === "string") {
    return { pattern: parsed.trim() };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("find payload 必须是 pattern 字符串或 JSON 对象");
  }

  const record = parsed as Record<string, unknown>;
  const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
  if (!pattern) {
    throw new Error("find payload 缺少 pattern");
  }

  return {
    pattern,
    path: typeof record.path === "string" ? record.path.trim() : undefined,
    maxResults: typeof record.maxResults === "number" && record.maxResults > 0
      ? Math.floor(record.maxResults)
      : undefined,
  };
}

async function runFindTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }
  throwIfAborted(context.signal);

  const params = parseFindPayload(payload);
  const cwd = resolveBaseDir(context);
  const searchPath = params.path
    ? resolvePathForTool(params.path, context)
    : cwd;

  const maxResults = params.maxResults ?? FIND_DEFAULT_MAX_RESULTS;

  // Use fd if available, fallback to find
  const useFd = true; // Prefer fd for better glob support
  const args = useFd
    ? ["--type", "f", "--glob", params.pattern, searchPath]
    : [searchPath, "-type", "f", "-name", params.pattern];
  const cmd = useFd ? "fd" : "find";

  logger.info(`[tool.find] cwd=${cwd} pattern=${params.pattern} path=${searchPath}`);

  return await new Promise<string>((resolve, reject) => {
    const signal = context.signal;
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(createAbortError());
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < EXEC_MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < EXEC_MAX_OUTPUT_BYTES) {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      // If fd is not installed, fall back to find
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && useFd) {
        // Retry with standard find
        const findArgs = [searchPath, "-type", "f", "-name", params.pattern];
        const findChild = spawn("find", findArgs, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        let findStdout = Buffer.alloc(0);
        findChild.stdout?.on("data", (chunk: Buffer) => {
          if (findStdout.length < EXEC_MAX_OUTPUT_BYTES) {
            findStdout = Buffer.concat([findStdout, chunk]);
          }
        });

        findChild.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`find exited with code ${code}`));
            return;
          }
          const outText = findStdout.toString("utf8").trim();
          if (!outText) {
            resolve(`📁 find: "${params.pattern}" - 未找到文件`);
            return;
          }
          const files = outText.split("\n").filter(Boolean);
          const truncated = files.length > maxResults;
          const displayFiles = files.slice(0, maxResults);
          resolve([
            `📁 find: "${params.pattern}" (${files.length} files${truncated ? ", showing " + maxResults : ""})`,
            "",
            ...displayFiles,
            truncated ? `\n…(${files.length - maxResults} more files)` : "",
          ].filter(Boolean).join("\n"));
        });
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      const outText = stdout.toString("utf8").trim();
      const errText = stderr.toString("utf8").trim();

      if (code !== 0 && errText) {
        reject(new Error(errText));
        return;
      }

      if (!outText) {
        resolve(`📁 find: "${params.pattern}" - 未找到文件`);
        return;
      }

      const files = outText.split("\n").filter(Boolean);
      const truncated = files.length > maxResults;
      const displayFiles = files.slice(0, maxResults);

      const result = [
        `📁 find: "${params.pattern}" (${files.length} files${truncated ? ", showing " + maxResults : ""})`,
        "",
        ...displayFiles,
        truncated ? `\n…(${files.length - maxResults} more files)` : "",
      ].filter(Boolean).join("\n");

      resolve(result);
    });
  });
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

    const batchResults = await Promise.all(batch.map((invocation) => executeInvocation(invocation)));
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
  const usesToolBlocks = activeAgentId !== "gemini" && activeAgentId !== "claude";
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
        '{"agentId":"claude","prompt":"请帮我润色这段文档..."}',
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

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { AgentRunResult } from "./types.js";
import { SearchTool } from "../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../tools/search/config.js";
import { checkTavilySetup } from "../tools/search/setupCodexMcp.js";
import type { SearchParams, SearchResponse } from "../tools/search/types.js";
import { createLogger } from "../utils/logger.js";

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

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isExecToolEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_EXEC_TOOL, false);
}

function isFileToolsEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_FILE_TOOLS, false);
}

function isApplyPatchEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_APPLY_PATCH, false);
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

function getExecAllowlist(): string[] | null {
  const env = process.env.AGENT_EXEC_TOOL_ALLOWLIST;
  if (env === undefined) {
    return null;
  }
  const parsed = parseCsv(env)
    .map((entry) => entry.toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) {
    return null;
  }
  if (parsed.includes("*") || parsed.includes("all")) {
    return null;
  }
  return parsed;
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

export interface ToolExecutionContext {
  cwd?: string;
  allowedDirs?: string[];
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
    throw new Error("exec 工具未启用（设置 ENABLE_AGENT_EXEC_TOOL=1 打开）");
  }

  const { cmd: rawCmd, args, timeoutMs } = parseExecPayload(payload);
  const cwd = resolveBaseDir(context);
  const executable = path.basename(rawCmd).toLowerCase();
  const allowlist = getExecAllowlist();
  if (allowlist && !allowlist.includes(executable)) {
    throw new Error(`不允许执行命令: ${executable}（可用 AGENT_EXEC_TOOL_ALLOWLIST 配置白名单；'*' 表示不限制）`);
  }

  const commandLine = [rawCmd, ...args].join(" ").trim();
  logger.info(`[tool.exec] cwd=${cwd} cmd=${commandLine}`);

  return await new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(rawCmd, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncatedStdout = false;
    let truncatedStderr = false;
    let timedOut = false;

    const append = (
      target: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
      kind: "stdout" | "stderr",
    ): Buffer<ArrayBufferLike> => {
      if (target.length >= EXEC_MAX_OUTPUT_BYTES) {
        if (kind === "stdout") truncatedStdout = true;
        if (kind === "stderr") truncatedStderr = true;
        return target;
      }
      const remaining = EXEC_MAX_OUTPUT_BYTES - target.length;
      if (chunk.length > remaining) {
        if (kind === "stdout") truncatedStdout = true;
        if (kind === "stderr") truncatedStderr = true;
        return Buffer.concat([target, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([target, chunk]);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        logger.warn("[tool.exec] Failed to kill timed-out process", error);
      }
    }, Math.max(1, timeoutMs));

    child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = append(stdout, chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = append(stderr, chunk, "stderr");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      const lines: string[] = [];
      lines.push(`$ ${commandLine}`);
      if (timedOut) {
        lines.push(`⏱️ timeout after ${timeoutMs}ms`);
      }
      lines.push(`exit=${code ?? "null"} signal=${signal ?? "null"} elapsed=${elapsedMs}ms`);

      const outText = stdout.toString("utf8").trimEnd();
      const errText = stderr.toString("utf8").trimEnd();

      if (outText) {
        lines.push("");
        lines.push("stdout:");
        lines.push("```");
        lines.push(outText + (truncatedStdout ? "\n…(truncated)" : ""));
        lines.push("```");
      }
      if (errText) {
        lines.push("");
        lines.push("stderr:");
        lines.push("```");
        lines.push(errText + (truncatedStderr ? "\n…(truncated)" : ""));
        lines.push("```");
      }
      resolve(lines.join("\n").trim());
    });
  });
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
    throw new Error("file 工具未启用（设置 ENABLE_AGENT_FILE_TOOLS=1 打开）");
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
    throw new Error("file 工具未启用（设置 ENABLE_AGENT_FILE_TOOLS=1 打开）");
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
    throw new Error("file 工具未启用（设置 ENABLE_AGENT_FILE_TOOLS=1 打开）");
  }
  if (!isApplyPatchEnabled()) {
    throw new Error("apply_patch 工具未启用（设置 ENABLE_AGENT_APPLY_PATCH=1 打开）");
  }

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

    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const append = (key: "stdout" | "stderr", chunk: Buffer<ArrayBufferLike>) => {
      const current = buffers[key];
      const next = Buffer.concat([current, chunk]);
      buffers[key] = next.length > EXEC_MAX_OUTPUT_BYTES ? next.subarray(0, EXEC_MAX_OUTPUT_BYTES) : next;
    };

    child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => append("stderr", chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
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

async function runTool(name: string, payload: string, context: ToolExecutionContext): Promise<string> {
  switch (name) {
    case "search":
      return handleSearchTool(payload);
    case "exec":
      return runExecTool(payload, context);
    case "read":
      return runReadTool(payload, context);
    case "write":
      return runWriteTool(payload, context);
    case "apply_patch":
      return runApplyPatchTool(payload, context);
    default:
      throw new Error(`未知工具: ${name}`);
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

  let replacedText = text;
  const results: ToolExecutionResult[] = [];
  const summaries: ToolCallSummary[] = [];

  for (const invocation of invocations) {
    await hooks?.onInvoke?.(invocation.name, invocation.payload);
    try {
      const output = await runTool(invocation.name, invocation.payload, context);
      replacedText = replacedText.replace(invocation.raw, output);
      results.push({ tool: invocation.name, payload: invocation.payload, ok: true, output });
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
      replacedText = replacedText.replace(invocation.raw, fallback);
      results.push({ tool: invocation.name, payload: invocation.payload, ok: false, output: fallback });
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

  return { replacedText, strippedText: stripToolBlocks(text), results, summaries };
}

export function injectToolGuide(
  input: string,
  options?: {
    activeAgentId?: string;
  },
): string {
  const activeAgentId = options?.activeAgentId ?? "codex";
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

  const guideLines: string[] = [];

  if (wantsSearchGuide()) {
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

  if (activeAgentId !== "codex" && isFileToolsEnabled()) {
    guideLines.push(
      [
        "read - 读取本地文件（需要 ENABLE_AGENT_FILE_TOOLS=1，受目录白名单限制），格式：",
        "<<<tool.read",
        '{"path":"src/index.ts","startLine":1,"endLine":120}',
        ">>>",
        "write - 写入本地文件（需要 ENABLE_AGENT_FILE_TOOLS=1，受目录白名单限制），格式：",
        "<<<tool.write",
        '{"path":"src/example.txt","content":"hello"}',
        ">>>",
      ].join("\n"),
    );
    if (isApplyPatchEnabled()) {
      guideLines.push(
        [
          "apply_patch - 通过 unified diff 应用补丁（需要 ENABLE_AGENT_APPLY_PATCH=1 + git，受目录白名单限制），格式：",
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

  if (activeAgentId !== "codex" && isExecToolEnabled()) {
    guideLines.push(
      [
        "exec - 在本机执行命令（需要 ENABLE_AGENT_EXEC_TOOL=1；可选用 AGENT_EXEC_TOOL_ALLOWLIST 限制命令，'*' 表示不限制），格式：",
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

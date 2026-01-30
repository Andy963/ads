import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ToolExecutionContext } from "./context.js";
import { findGitRoot, isWithinAllowedDirs, resolveBaseDir, resolvePathForTool } from "./context.js";
import {
  EXEC_MAX_OUTPUT_BYTES,
  createAbortError,
  getPatchMaxBytes,
  getReadMaxBytes,
  getWriteMaxBytes,
  isApplyPatchEnabled,
  isFileToolsEnabled,
  logger,
  throwIfAborted,
} from "./shared.js";

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
    request?.startLine || request?.endLine ? ` (lines ${request.startLine ?? 1}-${request.endLine ?? "end"})` : "";
  const truncPart = truncated ? "\n…(truncated)" : "";
  return [`📄 ${relativeHint}${rangePart}`, "```", content.trimEnd() + truncPart, "```"].join("\n");
}

export async function runReadTool(payload: string, context: ToolExecutionContext): Promise<string> {
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

export async function runWriteTool(payload: string, context: ToolExecutionContext): Promise<string> {
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

export async function runApplyPatchTool(payload: string, context: ToolExecutionContext): Promise<string> {
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


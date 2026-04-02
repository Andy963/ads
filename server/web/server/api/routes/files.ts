import fs from "node:fs";
import path from "node:path";

import { sendJson } from "../../http.js";
import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { resolveTaskContextOrSendBadRequest } from "./shared.js";
import { validateWorkspaceFilePath } from "./workspacePath.js";

const MAX_PREVIEW_LINES = 400;
const PREVIEW_WINDOW_RADIUS = 200;
const BINARY_SAMPLE_BYTES = 8000;

type FilePreviewResponse = {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  language: string | null;
  line: number | null;
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitPreviewLines(text: string): string[] {
  const normalized = normalizeNewlines(text);
  if (!normalized) return [];
  const parts = normalized.split("\n");
  if (normalized.endsWith("\n") && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      return true;
    }
  }
  return false;
}

function guessLanguage(filePath: string): string | null {
  const ext = path.extname(String(filePath ?? "").trim()).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".toml":
    case ".ini":
      return "ini";
    case ".sh":
    case ".bash":
      return "bash";
    case ".md":
      return "markdown";
    case ".vue":
      return "vue";
    case ".css":
      return "css";
    case ".html":
      return "html";
    default:
      return null;
  }
}

function parseRequestedLine(raw: string | null): number | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return parsed;
}

function buildPreviewPayload(
  filePath: string,
  text: string,
  requestedLine: number | null,
  requestedStartLine: number | null,
): FilePreviewResponse {
  const lines = splitPreviewLines(text);
  const totalLines = lines.length;

  if (totalLines === 0) {
    return {
      path: filePath,
      content: "",
      totalLines: 0,
      startLine: 1,
      endLine: 0,
      truncated: false,
      language: guessLanguage(filePath),
      line: requestedLine,
    };
  }

  let startLine = 1;
  let endLine = totalLines;

  if (totalLines > MAX_PREVIEW_LINES) {
    const earliestStart = 1;
    const latestStart = Math.max(1, totalLines - MAX_PREVIEW_LINES + 1);
    if (requestedStartLine && requestedStartLine <= totalLines) {
      startLine = Math.min(latestStart, Math.max(earliestStart, requestedStartLine));
    } else if (requestedLine && requestedLine <= totalLines) {
      startLine = Math.min(
        latestStart,
        Math.max(earliestStart, requestedLine - PREVIEW_WINDOW_RADIUS),
      );
    }
    endLine = Math.min(totalLines, startLine + MAX_PREVIEW_LINES - 1);
  }

  const previewLines = lines.slice(startLine - 1, endLine);
  return {
    path: filePath,
    content: previewLines.join("\n"),
    totalLines,
    startLine,
    endLine,
    truncated: startLine > 1 || endLine < totalLines,
    language: guessLanguage(filePath),
    line: requestedLine,
  };
}

function sendFilePreviewError(res: ApiRouteContext["res"], status: number, error: string): true {
  sendJson(res, status, { error });
  return true;
}

export async function handleFileRoutes(
  ctx: ApiRouteContext,
  deps: Pick<ApiSharedDeps, "resolveTaskContext">,
): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method !== "GET" || pathname !== "/api/files/content") {
    return false;
  }

  const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
  if (!taskCtx) return true;

  const requestedPath = url.searchParams.get("path") ?? "";
  const requestedLine = parseRequestedLine(url.searchParams.get("line"));
  const requestedStartLine = parseRequestedLine(url.searchParams.get("startLine"));
  const validated = validateWorkspaceFilePath({
    candidatePath: requestedPath,
    workspaceRoot: taskCtx.workspaceRoot,
  });

  if (!validated.ok) {
    switch (validated.reason) {
      case "missing_path":
        return sendFilePreviewError(res, 400, "缺少 path 参数");
      case "not_allowed":
        return sendFilePreviewError(res, 403, "文件不在当前 workspace 内");
      case "not_exists":
        return sendFilePreviewError(res, 404, "文件不存在");
      case "not_file":
        return sendFilePreviewError(res, 400, "目标不是文件");
    }
  }

  let raw: Buffer;
  try {
    raw = fs.readFileSync(validated.resolvedPath);
  } catch {
    return sendFilePreviewError(res, 500, "读取文件失败");
  }

  if (isProbablyBinary(raw)) {
    return sendFilePreviewError(res, 415, "暂不支持预览二进制文件");
  }

  const text = raw.toString("utf8");
  const payload = buildPreviewPayload(validated.resolvedPath, text, requestedLine, requestedStartLine);
  sendJson(res, 200, payload);
  return true;
}

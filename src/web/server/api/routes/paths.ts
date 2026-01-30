import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DirectoryManager } from "../../../../telegram/utils/directoryManager.js";
import { detectWorkspaceFrom } from "../../../../workspace/detector.js";

import type { ApiRouteContext } from "../types.js";
import { sendJson } from "../../http.js";

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function deriveProjectSessionId(projectRoot: string): string {
  const digest = crypto.createHash("sha256").update(projectRoot).digest();
  return toBase64Url(digest);
}

export async function handlePathRoutes(ctx: ApiRouteContext, deps: { allowedDirs: string[] }): Promise<boolean> {
  const { req, res, pathname, url } = ctx;
  if (req.method !== "GET" || pathname !== "/api/paths/validate") {
    return false;
  }

  const candidate = url.searchParams.get("path")?.trim() ?? "";
  const directoryManager = new DirectoryManager(deps.allowedDirs);
  if (!candidate) {
    sendJson(res, 200, {
      ok: false,
      allowed: false,
      exists: false,
      isDirectory: false,
      error: "缺少 path 参数",
    });
    return true;
  }

  const absolutePath = path.resolve(candidate);
  if (!directoryManager.validatePath(absolutePath)) {
    sendJson(res, 200, {
      ok: false,
      allowed: false,
      exists: false,
      isDirectory: false,
      error: "目录不在白名单内",
      allowedDirs: deps.allowedDirs,
    });
    return true;
  }

  if (!fs.existsSync(absolutePath)) {
    sendJson(res, 200, {
      ok: false,
      allowed: true,
      exists: false,
      isDirectory: false,
      resolvedPath: absolutePath,
      error: "目录不存在",
    });
    return true;
  }

  let resolvedPath = absolutePath;
  try {
    resolvedPath = fs.realpathSync(absolutePath);
  } catch {
    resolvedPath = absolutePath;
  }

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolvedPath).isDirectory();
  } catch {
    isDirectory = false;
  }

  if (!isDirectory) {
    sendJson(res, 200, {
      ok: false,
      allowed: true,
      exists: true,
      isDirectory: false,
      resolvedPath,
      error: "路径存在但不是目录",
    });
    return true;
  }

  const workspaceRootCandidate = detectWorkspaceFrom(resolvedPath);
  let workspaceRoot = workspaceRootCandidate;
  try {
    workspaceRoot = fs.realpathSync(workspaceRootCandidate);
  } catch {
    workspaceRoot = workspaceRootCandidate;
  }
  if (!directoryManager.validatePath(workspaceRoot)) {
    workspaceRoot = resolvedPath;
  }

  sendJson(res, 200, {
    ok: true,
    allowed: true,
    exists: true,
    isDirectory: true,
    resolvedPath,
    workspaceRoot,
    projectSessionId: deriveProjectSessionId(workspaceRoot),
  });
  return true;
}


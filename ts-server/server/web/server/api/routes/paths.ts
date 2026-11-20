import fs from "node:fs";

import { deriveProjectSessionId } from "../../projectSessionId.js";
import { validateWorkspacePath } from "./workspacePath.js";

import type { ApiRouteContext } from "../types.js";
import { sendJson } from "../../http.js";

export async function handlePathRoutes(ctx: ApiRouteContext, deps: { allowedDirs: string[] }): Promise<boolean> {
  const { req, res, pathname, url } = ctx;
  if (req.method === "GET" && pathname === "/api/paths/subdirs") {
    const dirs: string[] = [];
    for (const allowedDir of deps.allowedDirs) {
      try {
        const entries = fs.readdirSync(allowedDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            dirs.push(entry.name);
          }
        }
      } catch {
        // ignore dirs that don't exist
      }
    }
    sendJson(res, 200, {
      dirs: [...new Set(dirs)],
      allowedDirs: deps.allowedDirs,
    });
    return true;
  }

  if (req.method !== "GET" || pathname !== "/api/paths/validate") {
    return false;
  }

  const validated = validateWorkspacePath({
    candidatePath: url.searchParams.get("path") ?? "",
    allowedDirs: deps.allowedDirs,
  });

  if (!validated.ok) {
    switch (validated.reason) {
      case "missing_path":
        sendJson(res, 200, {
          ok: false,
          allowed: false,
          exists: false,
          isDirectory: false,
          error: "缺少 path 参数",
        });
        return true;
      case "not_allowed":
        sendJson(res, 200, {
          ok: false,
          allowed: false,
          exists: false,
          isDirectory: false,
          error: "目录不在白名单内",
          allowedDirs: deps.allowedDirs,
        });
        return true;
      case "not_exists":
        sendJson(res, 200, {
          ok: false,
          allowed: true,
          exists: false,
          isDirectory: false,
          resolvedPath: validated.absolutePath ?? "",
          error: "目录不存在",
        });
        return true;
      case "not_directory":
        sendJson(res, 200, {
          ok: false,
          allowed: true,
          exists: true,
          isDirectory: false,
          resolvedPath: validated.resolvedPath ?? validated.absolutePath ?? "",
          error: "路径存在但不是目录",
        });
        return true;
    }
  }

  sendJson(res, 200, {
    ok: true,
    allowed: true,
    exists: true,
    isDirectory: true,
    resolvedPath: validated.resolvedPath,
    workspaceRoot: validated.workspaceRoot,
    projectSessionId: deriveProjectSessionId(validated.workspaceRoot),
  });
  return true;
}

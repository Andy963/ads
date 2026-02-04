import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { DirectoryManager } from "../../../../telegram/utils/directoryManager.js";
import { detectWorkspaceFrom } from "../../../../workspace/detector.js";
import { getStateDatabase } from "../../../../state/database.js";
import { ensureWebAuthTables } from "../../../auth/schema.js";
import { deriveProjectSessionId } from "../../projectSessionId.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";
import { ensureWebProjectTables } from "../../../projects/schema.js";
import {
  deleteWebProject,
  getActiveWebProjectId,
  listWebProjects,
  reorderWebProjects,
  setActiveWebProjectId,
  updateWebProject,
  upsertWebProject,
} from "../../../projects/store.js";

type ProjectsResponse = {
  projects: ReturnType<typeof listWebProjects>;
  activeProjectId: string | null;
};

function resolveAndValidateWorkspaceRoot(args: { candidatePath: string; allowedDirs: string[] }): {
  ok: true;
  workspaceRoot: string;
  projectId: string;
} | {
  ok: false;
  error: string;
} {
  const candidate = String(args.candidatePath ?? "").trim();
  if (!candidate) {
    return { ok: false, error: "path is required" };
  }

  const directoryManager = new DirectoryManager(args.allowedDirs);
  const absolutePath = path.resolve(candidate);
  if (!directoryManager.validatePath(absolutePath)) {
    return { ok: false, error: "path is not allowed" };
  }

  if (!fs.existsSync(absolutePath)) {
    return { ok: false, error: "path does not exist" };
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
    return { ok: false, error: "path is not a directory" };
  }

  let workspaceRootCandidate = detectWorkspaceFrom(resolvedPath);
  try {
    workspaceRootCandidate = fs.realpathSync(workspaceRootCandidate);
  } catch {
    // ignore
  }
  if (!directoryManager.validatePath(workspaceRootCandidate)) {
    workspaceRootCandidate = resolvedPath;
  }

  return { ok: true, workspaceRoot: workspaceRootCandidate, projectId: deriveProjectSessionId(workspaceRootCandidate) };
}

export async function handleProjectRoutes(
  ctx: ApiRouteContext,
  deps: { allowedDirs: string[] },
): Promise<boolean> {
  const { req, res, pathname, auth } = ctx;

  if (req.method === "GET" && pathname === "/api/projects") {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const projects = listWebProjects(db, auth.userId);
    const activeProjectId = getActiveWebProjectId(db, auth.userId);
    sendJson(res, 200, { projects, activeProjectId } satisfies ProjectsResponse);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/projects") {
    const body = await readJsonBody(req);
    const schema = z.object({ path: z.string().min(1), name: z.string().optional() }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const validated = resolveAndValidateWorkspaceRoot({ candidatePath: parsed.data.path, allowedDirs: deps.allowedDirs });
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return true;
    }

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);

    const name = parsed.data.name?.trim() || path.basename(validated.workspaceRoot) || "Project";
    const project = upsertWebProject(db, {
      userId: auth.userId,
      projectId: validated.projectId,
      workspaceRoot: validated.workspaceRoot,
      name,
      chatSessionId: "main",
    });
    setActiveWebProjectId(db, auth.userId, project.id);
    sendJson(res, 200, { project, activeProjectId: project.id });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/projects/reorder") {
    const body = await readJsonBody(req);
    const schema = z.object({ ids: z.array(z.string().min(1)) }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const ids = parsed.data.ids.map((id) => String(id ?? "").trim()).filter(Boolean);

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    try {
      reorderWebProjects(db, auth.userId, ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
      return true;
    }

    sendJson(res, 200, { success: true });
    return true;
  }

  const deleteMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (deleteMatch && req.method === "DELETE") {
    const projectId = String(deleteMatch[1] ?? "").trim();
    if (!projectId) {
      sendJson(res, 400, { error: "projectId is required" });
      return true;
    }

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);

    const deleted = deleteWebProject(db, auth.userId, projectId);
    const currentActive = getActiveWebProjectId(db, auth.userId);
    let nextActive = currentActive;
    if (currentActive === projectId) {
      nextActive = "default";
      setActiveWebProjectId(db, auth.userId, nextActive);
    }
    sendJson(res, 200, { success: deleted, activeProjectId: nextActive });
    return true;
  }

  if (req.method === "PATCH" && pathname === "/api/projects/active") {
    const body = await readJsonBody(req);
    const schema = z.object({ projectId: z.string().min(1).nullable() }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const projectId = parsed.data.projectId == null ? null : String(parsed.data.projectId).trim();
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    setActiveWebProjectId(db, auth.userId, projectId && projectId !== "default" ? projectId : "default");
    sendJson(res, 200, { success: true });
    return true;
  }

  const updateMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (updateMatch && req.method === "PATCH") {
    const projectId = String(updateMatch[1] ?? "").trim();
    if (!projectId) {
      sendJson(res, 400, { error: "projectId is required" });
      return true;
    }
    const body = await readJsonBody(req);
    const schema = z
      .object({
        name: z.string().min(1).optional(),
        chatSessionId: z.string().min(1).optional(),
      })
      .passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const updated = updateWebProject(db, { userId: auth.userId, projectId, name: parsed.data.name, chatSessionId: parsed.data.chatSessionId });
    if (!updated) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    sendJson(res, 200, { success: true, project: updated });
    return true;
  }

  return false;
}

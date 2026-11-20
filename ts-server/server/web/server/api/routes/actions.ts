import path from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../../../../state/database.js";
import { LaneDispatchBus } from "../../../../actions/bus.js";
import { ensureWebAuthTables } from "../../../auth/schema.js";
import { ensureWebProjectTables } from "../../../projects/schema.js";
import type { ApiRouteContext } from "../types.js";
import { sendJson } from "../../http.js";
import { validateWorkspacePath } from "./workspacePath.js";

export interface ActionRouteDeps {
  resolveWorkspaceRoot?: (url: URL) => string;
  allowedDirs?: string[];
}

export type ResolvedProjectContext = {
  projectId: string;
  repoPath: string;
};

function toActionJobResponse(job: Record<string, unknown>): Record<string, unknown> {
  const {
    auth_user_id: _authUserId,
    chat_session_id: _chatSessionId,
    ...publicJob
  } = job;
  return publicJob;
}

let busInstance: LaneDispatchBus | null = null;

export function setBusInstance(bus: LaneDispatchBus): void {
  busInstance = bus;
}

export function getBus(): LaneDispatchBus {
  if (!busInstance) {
    busInstance = new LaneDispatchBus(getStateDatabase());
  }
  return busInstance;
}

function resolveOwnedProject(
  db: DatabaseType,
  userId: string,
  candidateValue: string | null | undefined,
  allowedDirs: string[],
): ResolvedProjectContext | null {
  const candidate = String(candidateValue ?? "").trim();
  const owner = String(userId ?? "").trim();
  if (!candidate || !owner || allowedDirs.length === 0) return null;

  try {
    const byId = db
      .prepare(
        "SELECT project_id, workspace_root FROM web_projects WHERE user_id = ? AND project_id = ? LIMIT 1",
      )
      .get(owner, candidate) as { project_id?: unknown; workspace_root?: unknown } | undefined;

    const validateRoot = (row: { project_id?: unknown; workspace_root?: unknown }): ResolvedProjectContext | null => {
      const projectId = String(row.project_id ?? "").trim();
      const workspaceRoot = String(row.workspace_root ?? "").trim();
      if (!projectId || !workspaceRoot) return null;
      const validated = validateWorkspacePath({
        candidatePath: workspaceRoot,
        allowedDirs,
        allowWorkspaceRootFallback: false,
      });
      if (!validated.ok) return null;
      return { projectId, repoPath: validated.workspaceRoot };
    };

    if (byId) return validateRoot(byId);

    const validatedCandidate = validateWorkspacePath({
      candidatePath: candidate,
      allowedDirs,
      allowWorkspaceRootFallback: false,
    });
    if (!validatedCandidate.ok) return null;

    const byPath = db
      .prepare(
        "SELECT project_id, workspace_root FROM web_projects WHERE user_id = ? AND workspace_root = ? LIMIT 1",
      )
      .get(owner, validatedCandidate.workspaceRoot) as { project_id?: unknown; workspace_root?: unknown } | undefined;
    return byPath ? validateRoot(byPath) : null;
  } catch {
    return null;
  }
}

export function resolveProjectContext(
  db: DatabaseType,
  userId: string,
  rawProjectId?: string | null,
  rawRepoPath?: string | null,
  fallbackUrl?: URL,
  resolveWorkspaceRoot?: (url: URL) => string,
  allowedDirs: string[] = [],
): ResolvedProjectContext | null {
  const projectIdInput = String(rawProjectId ?? "").trim();
  const repoPathInput = String(rawRepoPath ?? "").trim();
  const byProjectId = resolveOwnedProject(db, userId, rawProjectId, allowedDirs);
  const byRepoPath = resolveOwnedProject(db, userId, rawRepoPath, allowedDirs);
  if ((projectIdInput && !byProjectId) || (repoPathInput && !byRepoPath)) return null;
  if (byProjectId && byRepoPath) {
    if (byProjectId.projectId !== byRepoPath.projectId || path.resolve(byProjectId.repoPath) !== path.resolve(byRepoPath.repoPath)) {
      return null;
    }
    return byProjectId;
  }
  if (byProjectId) return byProjectId;
  if (byRepoPath) return byRepoPath;

  if (!projectIdInput && !repoPathInput && fallbackUrl && resolveWorkspaceRoot) {
    try {
      return resolveOwnedProject(db, userId, resolveWorkspaceRoot(fallbackUrl), allowedDirs);
    } catch {
      // ignore invalid workspace query parameters
    }
  }
  return null;
}

export async function handleActionRoutes(ctx: ApiRouteContext, deps: ActionRouteDeps = {}): Promise<boolean> {
  const { req, res, pathname, url, auth } = ctx;
  const bus = getBus();
  const stateDb = getStateDatabase();
  ensureWebAuthTables(stateDb);
  ensureWebProjectTables(stateDb);
  const allowedDirs = deps.allowedDirs ?? [];

  if (pathname === "/api/actions/dispatch" && req.method === "POST") {
    sendJson(res, 410, { error: "Asynchronous Actions dispatch is retired; implement in Acopilot." });
    return true;
  }

  if (pathname === "/api/actions/queue/start" && req.method === "POST") {
    sendJson(res, 410, { error: "Asynchronous Actions queue execution is retired; continue in Acopilot." });
    return true;
  }

  if (pathname === "/api/actions/jobs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    const resolved = resolveProjectContext(stateDb, auth.userId, projectId, null, url, deps.resolveWorkspaceRoot, allowedDirs);
    if (!resolved) {
      sendJson(res, 400, { error: `Invalid or unauthorized project '${projectId}'` });
      return true;
    }
    bus.resumeReviewQueue(resolved.projectId, resolved.repoPath);
    const jobs = bus.getJobs(resolved.projectId, resolved.repoPath, auth.userId);
    sendJson(res, 200, jobs.map((job) => toActionJobResponse(job as unknown as Record<string, unknown>)));
    return true;
  }

  if (pathname.startsWith("/api/actions/") && req.method === "POST") {
    sendJson(res, 410, { error: "Asynchronous Actions job operations are retired; continue implementation and review in Acopilot." });
    return true;
  }

  return false;
}

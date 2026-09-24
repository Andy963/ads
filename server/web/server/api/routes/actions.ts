import fs from "node:fs";
import { z } from "zod";
import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../../../../state/database.js";
import { LaneDispatchBus } from "../../../../actions/bus.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

const dispatchSchema = z.object({
  projectId: z.string(),
  issueId: z.number().nullable().optional(),
  issueTitle: z.string(),
  jobKind: z.enum(["github_issue", "local_prompt"]).optional(),
  repoPath: z.string().optional(),
  developerProfileId: z.string().nullable().optional(),
  reviewerProfileIds: z.array(z.string()).optional(),
});

export interface ActionRouteDeps {
  resolveWorkspaceRoot?: (url: URL) => string;
}

type ActionMutationBody = {
  projectId?: unknown;
  repoPath?: unknown;
};

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

export function resolveRepoPath(
  db: DatabaseType,
  rawPathOrProjectId?: string | null,
  fallbackUrl?: URL,
  resolveWorkspaceRoot?: (url: URL) => string,
): string | null {
  const candidate = String(rawPathOrProjectId ?? "").trim();
  if (candidate && fs.existsSync(candidate)) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore
    }
  }

  if (candidate) {
    try {
      const row = db.prepare("SELECT workspace_root FROM web_projects WHERE project_id = ? LIMIT 1").get(candidate) as
        | { workspace_root?: string }
        | undefined;
      const root = row?.workspace_root?.trim();
      if (root && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        return root;
      }
    } catch {
      // ignore
    }
  }

  if (fallbackUrl && resolveWorkspaceRoot) {
    try {
      const root = resolveWorkspaceRoot(fallbackUrl)?.trim();
      if (root && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        return root;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export async function handleActionRoutes(ctx: ApiRouteContext, deps: ActionRouteDeps = {}): Promise<boolean> {
  const { req, res, pathname, url } = ctx;
  const bus = getBus();
  const stateDb = getStateDatabase();

  if (pathname === "/api/actions/dispatch" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const parsed = dispatchSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid dispatch payload", details: parsed.error.issues });
      return true;
    }

    const repoPath = resolveRepoPath(stateDb, parsed.data.repoPath || parsed.data.projectId, url, deps.resolveWorkspaceRoot);
    if (!repoPath) {
      sendJson(res, 400, { error: `Invalid or non-existent repository path: ${parsed.data.repoPath || parsed.data.projectId}` });
      return true;
    }

    const result = bus.dispatchJob({
      projectId: parsed.data.projectId,
      issueId: parsed.data.issueId,
      issueTitle: parsed.data.issueTitle,
      jobKind: parsed.data.jobKind,
      repoPath,
      developerProfileId: parsed.data.developerProfileId,
      reviewerProfileIds: parsed.data.reviewerProfileIds,
    });

    sendJson(res, 200, result);
    return true;
  }

  if (pathname === "/api/actions/queue/start" && req.method === "POST") {
    let body: ActionMutationBody = {};
    try {
      const parsed = await readJsonBody(req);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as ActionMutationBody;
      }
    } catch {
      // body can be empty
    }

    const requestedProjectId = typeof body.projectId === "string" ? body.projectId : null;
    const projectId = String(requestedProjectId ?? url.searchParams.get("projectId") ?? "").trim();
    if (!projectId) {
      sendJson(res, 400, { error: "Missing projectId parameter" });
      return true;
    }

    const requestedRepoPath = typeof body.repoPath === "string" ? body.repoPath : null;
    const repoPath = resolveRepoPath(stateDb, requestedRepoPath || projectId, url, deps.resolveWorkspaceRoot);
    if (!repoPath) {
      sendJson(res, 400, { error: `Invalid or non-existent repository path for project '${projectId}'` });
      return true;
    }

    const result = await bus.evaluateQueue(projectId, repoPath);
    sendJson(res, 200, {
      ok: result.allowed,
      ...result,
    });
    return true;
  }

  if (pathname === "/api/actions/jobs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    const jobs = bus.getJobs(projectId);
    sendJson(res, 200, jobs);
    return true;
  }

  const mergeMatch = /^\/api\/actions\/jobs\/([^/]+)\/merge$/.exec(pathname);
  if (mergeMatch && req.method === "POST") {
    let body: ActionMutationBody = {};
    try {
      const parsed = await readJsonBody(req);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as ActionMutationBody;
      }
    } catch {
      // ignore
    }

    const jobId = decodeURIComponent(mergeMatch[1] ?? "");
    const job = bus.getJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: `Job not found: ${jobId}` });
      return true;
    }

    const requestedRepoPath = typeof body.repoPath === "string" ? body.repoPath : null;
    const repoPath = resolveRepoPath(stateDb, requestedRepoPath || job.project_id, url, deps.resolveWorkspaceRoot);
    if (!repoPath) {
      sendJson(res, 400, { error: `Job project directory does not exist for project '${job.project_id}'` });
      return true;
    }

    const result = bus.executeDeterministicMerge(jobId, repoPath);
    sendJson(res, result.success ? 200 : 500, result);
    return true;
  }

  const cancelMatch = /^\/api\/actions\/jobs\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch && req.method === "POST") {
    let body: ActionMutationBody = {};
    try {
      const parsed = await readJsonBody(req);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as ActionMutationBody;
      }
    } catch {
      // ignore
    }

    const jobId = decodeURIComponent(cancelMatch[1] ?? "");
    const job = bus.getJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: `Job not found: ${jobId}` });
      return true;
    }
    const requestedRepoPath = typeof body.repoPath === "string" ? body.repoPath : null;
    const repoPath = resolveRepoPath(stateDb, requestedRepoPath || job.project_id, url, deps.resolveWorkspaceRoot);
    if (!repoPath) {
      sendJson(res, 400, { error: `Job project directory does not exist for project '${job.project_id}'` });
      return true;
    }
    bus.cancelJob(jobId, repoPath);
    sendJson(res, 200, { ok: true, jobId, status: "cancelled" });
    return true;
  }

  return false;
}

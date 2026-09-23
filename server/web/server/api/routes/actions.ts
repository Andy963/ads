import fs from "node:fs";
import { z } from "zod";

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

let busInstance: LaneDispatchBus | null = null;

function getBus(): LaneDispatchBus {
  if (!busInstance) {
    busInstance = new LaneDispatchBus(getStateDatabase());
  }
  return busInstance;
}

export async function handleActionRoutes(ctx: ApiRouteContext, deps: ActionRouteDeps = {}): Promise<boolean> {
  const { req, res, pathname, url } = ctx;
  const bus = getBus();

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

    const repoPath = parsed.data.repoPath || parsed.data.projectId || (deps.resolveWorkspaceRoot ? deps.resolveWorkspaceRoot(url) : null);
    if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      sendJson(res, 400, { error: `Invalid or non-existent repository path: ${repoPath}` });
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

  if (pathname === "/api/actions/jobs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    const jobs = bus.getJobs(projectId);
    sendJson(res, 200, jobs);
    return true;
  }

  const mergeMatch = /^\/api\/actions\/jobs\/([^/]+)\/merge$/.exec(pathname);
  if (mergeMatch && req.method === "POST") {
    const jobId = decodeURIComponent(mergeMatch[1] ?? "");
    const job = bus.getJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: `Job not found: ${jobId}` });
      return true;
    }

    const repoPath = job.project_id;
    if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      sendJson(res, 400, { error: `Job project directory does not exist: ${repoPath}` });
      return true;
    }

    const result = bus.executeDeterministicMerge(jobId, repoPath);
    sendJson(res, result.success ? 200 : 500, result);
    return true;
  }

  const cancelMatch = /^\/api\/actions\/jobs\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch && req.method === "POST") {
    const jobId = decodeURIComponent(cancelMatch[1] ?? "");
    const job = bus.getJob(jobId);
    if (!job) {
      sendJson(res, 404, { error: `Job not found: ${jobId}` });
      return true;
    }
    bus.cancelJob(jobId, job.project_id);
    sendJson(res, 200, { ok: true, jobId, status: "cancelled" });
    return true;
  }

  return false;
}

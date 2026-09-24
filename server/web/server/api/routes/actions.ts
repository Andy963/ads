import path from "node:path";
import { z } from "zod";
import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../../../../state/database.js";
import { LaneDispatchBus } from "../../../../actions/bus.js";
import { ensureWebAuthTables } from "../../../auth/schema.js";
import { ensureWebProjectTables } from "../../../projects/schema.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";
import { validateWorkspacePath } from "./workspacePath.js";

const dispatchSchema = z.object({
  projectId: z.string(),
  issueId: z.number().nullable().optional(),
  issueTitle: z.string(),
  issueDescription: z.string().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)),
  adrs: z.array(z.object({
    id: z.string(),
    title: z.string(),
    decision: z.string(),
  })).optional(),
  jobKind: z.enum(["github_issue", "local_prompt"]).optional(),
  repoPath: z.string().optional(),
  developerProfileId: z.string().nullable().optional(),
  reviewerProfileIds: z.array(z.string()).optional(),
}).superRefine((data, ctx) => {
  const jobKind = data.jobKind ?? (data.issueId ? "github_issue" : "local_prompt");
  if (jobKind === "github_issue" && data.acceptanceCriteria.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acceptanceCriteria"],
      message: "GitHub Issue jobs require at least one acceptance criterion",
    });
  }
});

export interface ActionRouteDeps {
  resolveWorkspaceRoot?: (url: URL) => string;
  allowedDirs?: string[];
}

type ActionMutationBody = {
  projectId?: unknown;
  repoPath?: unknown;
};

export type ResolvedProjectContext = {
  projectId: string;
  repoPath: string;
};

function toActionJobResponse(job: Record<string, unknown>): Record<string, unknown> {
  const { auth_user_id: _authUserId, chat_session_id: _chatSessionId, ...publicJob } = job;
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

    const resolved = resolveProjectContext(
      stateDb,
      auth.userId,
      parsed.data.projectId,
      parsed.data.repoPath,
      url,
      deps.resolveWorkspaceRoot,
      allowedDirs,
    );
    if (!resolved) {
      sendJson(res, 400, { error: `Invalid or unauthorized repository for project '${parsed.data.projectId}'` });
      return true;
    }

    const result = bus.dispatchJob({
      projectId: resolved.projectId,
      issueId: parsed.data.issueId,
      issueTitle: parsed.data.issueTitle,
      issueDescription: parsed.data.issueDescription,
      acceptanceCriteria: parsed.data.acceptanceCriteria,
      adrs: parsed.data.adrs,
      jobKind: parsed.data.jobKind ?? (parsed.data.issueId ? "github_issue" : "local_prompt"),
      repoPath: resolved.repoPath,
      developerProfileId: parsed.data.developerProfileId,
      reviewerProfileIds: parsed.data.reviewerProfileIds,
      authUserId: auth.userId,
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
    const resolved = resolveProjectContext(
      stateDb,
      auth.userId,
      projectId,
      requestedRepoPath,
      url,
      deps.resolveWorkspaceRoot,
      allowedDirs,
    );
    if (!resolved) {
      sendJson(res, 400, { error: `Invalid or unauthorized repository for project '${projectId}'` });
      return true;
    }

    const result = await bus.evaluateQueue(resolved.projectId, resolved.repoPath, auth.userId);
    sendJson(res, 200, {
      ok: result.allowed,
      ...result,
    });
    return true;
  }

  if (pathname === "/api/actions/jobs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    const resolved = resolveProjectContext(stateDb, auth.userId, projectId, null, url, deps.resolveWorkspaceRoot, allowedDirs);
    if (!resolved) {
      sendJson(res, 400, { error: `Invalid or unauthorized project '${projectId}'` });
      return true;
    }
    const jobs = bus.getJobs(resolved.projectId, resolved.repoPath, auth.userId);
    sendJson(res, 200, jobs.map((job) => toActionJobResponse(job as unknown as Record<string, unknown>)));
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
    const resolved = resolveProjectContext(
      stateDb,
      auth.userId,
      typeof body.projectId === "string" ? body.projectId : job.project_id,
      requestedRepoPath,
      url,
      deps.resolveWorkspaceRoot,
      allowedDirs,
    );
    if (!resolved) {
      sendJson(res, 400, { error: `Invalid or unauthorized repository for job '${jobId}'` });
      return true;
    }
    const ownedJob = bus.getJobs(resolved.projectId, resolved.repoPath, auth.userId)
      .find((candidate) => candidate.id === jobId);
    if (!ownedJob) {
      sendJson(res, 404, { error: `Job not found: ${jobId}` });
      return true;
    }

    const result = bus.executeDeterministicMerge(jobId, resolved.repoPath);
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
    const resolved = resolveProjectContext(
      stateDb,
      auth.userId,
      typeof body.projectId === "string" ? body.projectId : job.project_id,
      requestedRepoPath,
      url,
      deps.resolveWorkspaceRoot,
      allowedDirs,
    );
    if (!resolved) {
      sendJson(res, 400, { error: `Invalid or unauthorized repository for job '${jobId}'` });
      return true;
    }
    const ownedJob = bus.getJobs(resolved.projectId, resolved.repoPath, auth.userId)
      .find((candidate) => candidate.id === jobId);
    if (!ownedJob) {
      sendJson(res, 404, { error: `Job not found: ${jobId}` });
      return true;
    }
    bus.cancelJob(jobId, resolved.repoPath);
    sendJson(res, 200, { ok: true, jobId, status: "cancelled" });
    return true;
  }

  return false;
}

import type { ApiRouteContext, ApiSharedDeps } from "../types.js";
import { sendJson } from "../../http.js";
import { resolveTaskContextOrSendBadRequest } from "./tasks/shared.js";
import { toReviewArtifactSummary, type ReviewQueueItemStatus } from "../../../../tasks/reviewStore.js";

function parseReviewQueueStatus(value: string | null): ReviewQueueItemStatus | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "pending":
    case "running":
    case "passed":
    case "rejected":
    case "failed":
      return raw;
    default:
      return undefined;
  }
}

export async function handleReviewQueueRoutes(ctx: ApiRouteContext, deps: ApiSharedDeps): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  if (req.method === "GET" && pathname === "/api/review-queue") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const status = parseReviewQueueStatus(url.searchParams.get("status"));
    const limitRaw = url.searchParams.get("limit")?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

    const items = taskCtx.reviewStore.listQueueItems({ status, limit });
    const enriched = items.map((item) => {
      const task = taskCtx.taskStore.getTask(item.taskId);
      return {
        ...item,
        taskTitle: task?.title ?? "",
        taskStatus: task?.status ?? null,
        reviewRequired: task?.reviewRequired ?? null,
        reviewStatus: task?.reviewStatus ?? null,
        reviewConclusion: task?.reviewConclusion ?? null,
      };
    });
    sendJson(res, 200, { items: enriched });
    return true;
  }

  const snapshotMatch = /^\/api\/review-snapshots\/([^/]+)$/.exec(pathname);
  if (snapshotMatch && req.method === "GET") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const snapshotId = snapshotMatch[1] ?? "";
    const snapshot = taskCtx.reviewStore.getSnapshot(snapshotId);
    if (!snapshot) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    sendJson(res, 200, snapshot);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/review-artifacts/latest") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const latest = taskCtx.reviewStore.getLatestArtifact();
    sendJson(res, 200, { artifact: latest ? toReviewArtifactSummary(latest) : null });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/review-artifacts") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const taskId = String(url.searchParams.get("taskId") ?? "").trim();
    const snapshotId = String(url.searchParams.get("snapshotId") ?? "").trim();
    const limitRaw = url.searchParams.get("limit")?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const items = taskCtx.reviewStore
      .listArtifacts({ taskId: taskId || undefined, snapshotId: snapshotId || undefined, limit })
      .map((artifact) => toReviewArtifactSummary(artifact));
    sendJson(res, 200, { items });
    return true;
  }

  const artifactMatch = /^\/api\/review-artifacts\/([^/]+)$/.exec(pathname);
  if (artifactMatch && req.method === "GET") {
    const taskCtx = resolveTaskContextOrSendBadRequest(deps, url, res);
    if (!taskCtx) return true;
    const artifactId = artifactMatch[1] ?? "";
    const artifact = taskCtx.reviewStore.getArtifact(artifactId);
    if (!artifact) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    sendJson(res, 200, artifact);
    return true;
  }

  return false;
}


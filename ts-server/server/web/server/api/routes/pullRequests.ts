import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  PullRequestChecks,
  PullRequestDetail,
  PullRequestDetailResponse,
  PullRequestInvolvement,
  PullRequestListQuery,
  PullRequestListResponse,
  PullRequestState,
  PullRequestSummary,
} from "../../../../../shared/pullRequests.js";
import { getStateDatabase } from "../../../../state/database.js";
import { ensureWebAuthTables } from "../../../auth/schema.js";
import { ensureWebProjectTables } from "../../../projects/schema.js";
import { getWebProjectRecord } from "../../../projects/store.js";
import { sendJson } from "../../http.js";
import type { ApiRouteContext } from "../types.js";

const execFile = promisify(execFileCallback);
const LIST_TTL_MS = 30_000;
const DETAIL_TTL_MS = 60_000;
const CHECKS_TTL_MS = 15_000;
const DIFF_TTL_MS = 120_000;
const STATS_TTL_MS = 45_000;
const MAX_LIMIT = 50;
const MAX_CURSOR_OFFSET = 5_000;
const LIST_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "updatedAt",
  "createdAt",
  "labels",
  "statusCheckRollup",
  "additions",
  "deletions",
  "headRefName",
  "baseRefName",
].join(",");
const DETAIL_FIELDS = [
  LIST_FIELDS,
  "body",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "reviews",
  "files",
].join(",");

export type GhRunner = (args: string[], options: { cwd: string }) => Promise<{ stdout: string; stderr?: string }>;

type CacheEntry<T> = { expiresAt: number; value: T };
const listCache = new Map<string, CacheEntry<PullRequestListResponse>>();
const detailGroupCache = new Map<string, CacheEntry<PullRequestDetailResponse>>();
const inFlight = new Map<string, Promise<PullRequestListResponse | PullRequestDetailResponse>>();

export function resetPullRequestRouteCachesForTests(): void {
  listCache.clear();
  detailGroupCache.clear();
  inFlight.clear();
}

function defaultRunner(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr?: string }> {
  return execFile("gh", args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function normalizeChecks(value: unknown): PullRequestSummary["checks"] {
  if (!Array.isArray(value) || value.length === 0) return "unknown";
  let pending = false;
  for (const raw of value) {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const status = String(item.status ?? "").toUpperCase();
    const conclusion = String(item.conclusion ?? "").toUpperCase();
    if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) return "failing";
    if (status && status !== "COMPLETED") pending = true;
  }
  return pending ? "pending" : "passing";
}

function repositoryFromUrl(value: unknown): string {
  const url = String(value ?? "");
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return match?.[1] ?? "";
}

function labelsFrom(value: unknown): Array<{ name: string; color: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = String(item.name ?? "").trim();
    return name ? [{ name, color: String(item.color ?? "") }] : [];
  });
}

function toSummary(raw: unknown): PullRequestSummary | null {
  const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const number = Number(item.number);
  const url = String(item.url ?? "").trim();
  const title = String(item.title ?? "").trim();
  if (!Number.isSafeInteger(number) || number < 1 || !url || !title) return null;
  const author = item.author && typeof item.author === "object"
    ? String((item.author as Record<string, unknown>).login ?? "").trim()
    : "";
  return {
    number,
    repository: repositoryFromUrl(url),
    title,
    url,
    state: String(item.state ?? "").trim().toLowerCase(),
    isDraft: Boolean(item.isDraft),
    author,
    updatedAt: String(item.updatedAt ?? "").trim(),
    createdAt: String(item.createdAt ?? "").trim(),
    labels: labelsFrom(item.labels),
    checks: normalizeChecks(item.statusCheckRollup),
    additions: Number(item.additions ?? 0) || 0,
    deletions: Number(item.deletions ?? 0) || 0,
    headRefName: String(item.headRefName ?? "").trim(),
    baseRefName: String(item.baseRefName ?? "").trim(),
  };
}

function toDetail(raw: unknown): PullRequestDetail | null {
  const summary = toSummary(raw);
  if (!summary) return null;
  const item = raw as Record<string, unknown>;
  const checksDetail = Array.isArray(item.statusCheckRollup) ? item.statusCheckRollup.flatMap((entry) => {
    const check = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const name = String(check.name ?? check.context ?? "").trim();
    return name ? [{
      name,
      status: String(check.status ?? "").trim(),
      conclusion: String(check.conclusion ?? "").trim(),
      detailsUrl: String(check.detailsUrl ?? check.targetUrl ?? "").trim(),
    }] : [];
  }) : [];
  const reviews = Array.isArray(item.reviews) ? item.reviews.flatMap((entry) => {
    const review = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const author = review.author && typeof review.author === "object"
      ? String((review.author as Record<string, unknown>).login ?? "").trim()
      : "";
    return author ? [{
      author,
      state: String(review.state ?? "").trim(),
      submittedAt: String(review.submittedAt ?? "").trim(),
    }] : [];
  }) : [];
  const files = Array.isArray(item.files) ? item.files.flatMap((entry) => {
    const file = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const filePath = String(file.path ?? "").trim();
    return filePath ? [{
      path: filePath,
      additions: Number(file.additions ?? 0) || 0,
      deletions: Number(file.deletions ?? 0) || 0,
    }] : [];
  }) : [];
  return {
    ...summary,
    body: String(item.body ?? ""),
    mergeable: String(item.mergeable ?? "").trim(),
    mergeStateStatus: String(item.mergeStateStatus ?? "").trim(),
    reviewDecision: String(item.reviewDecision ?? "").trim(),
    checksDetail,
    reviews,
    files,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    const offset = Number(parsed.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_CURSOR_OFFSET) throw new Error("invalid offset");
    return offset;
  } catch {
    throw new Error("Invalid pull request cursor");
  }
}

function searchTerms(query: PullRequestListQuery): string[] {
  const terms: string[] = [];
  if (query.involvement === "author") terms.push("author:@me");
  if (query.involvement === "assignee") terms.push("assignee:@me");
  if (query.involvement === "mentions") terms.push("mentions:@me");
  if (query.involvement === "review-requested") terms.push("review-requested:@me");
  for (const label of query.labels) terms.push(`label:"${label.replace(/"/g, "")}"`);
  if (query.author.trim()) terms.push(`author:"${query.author.trim().replace(/"/g, "")}"`);
  if (query.checks === "passing") terms.push("status:success");
  if (query.checks === "failing") terms.push("status:failure");
  if (query.checks === "pending") terms.push("status:pending");
  return terms;
}

function listCacheKey(projectKey: string, query: PullRequestListQuery, offset: number): string {
  return JSON.stringify([projectKey, query.state, query.involvement, query.labels, query.author, query.checks, offset, query.limit]);
}

export async function listPullRequestsForProject(input: {
  projectKey: string;
  cwd: string;
  query: PullRequestListQuery;
  runner?: GhRunner;
  now?: number;
}): Promise<PullRequestListResponse> {
  const now = input.now ?? Date.now();
  const offset = decodeCursor(input.query.cursor);
  const key = listCacheKey(input.projectKey, input.query, offset);
  if (input.query.refresh) {
    listCache.delete(key);
    for (const detailKey of detailGroupCache.keys()) {
      if (detailKey.startsWith(`${input.projectKey}:`)) detailGroupCache.delete(detailKey);
    }
  }
  const cached = listCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const pending = inFlight.get(key);
  if (pending) return await pending as PullRequestListResponse;
  const task = (async () => {
    const args = [
      "pr",
      "list",
      "--state",
      input.query.state,
      "--limit",
      String(Math.min(MAX_CURSOR_OFFSET + MAX_LIMIT, offset + input.query.limit + 1)),
      "--json",
      LIST_FIELDS,
    ];
    const terms = searchTerms(input.query);
    if (terms.length) args.push("--search", terms.join(" "));
    try {
      const result = await (input.runner ?? defaultRunner)(args, { cwd: input.cwd });
      const parsed = JSON.parse(result.stdout || "[]") as unknown;
      if (!Array.isArray(parsed)) throw new Error("GitHub returned a non-array pull request list");
      let invalidRows = 0;
      const rows = parsed.flatMap((row) => {
        const summary = toSummary(row);
        if (!summary) invalidRows += 1;
        return summary ? [summary] : [];
      });
      const page = rows.slice(offset, offset + input.query.limit);
      const nextOffset = offset + page.length;
      const hasMore = rows.length > offset + page.length || parsed.length >= offset + input.query.limit + 1;
      const response: PullRequestListResponse = {
        items: page,
        nextCursor: hasMore ? encodeCursor(nextOffset) : null,
        partial: invalidRows > 0,
        ...(invalidRows > 0 ? { error: `${invalidRows} pull request row(s) could not be parsed` } : {}),
        fetchedAt: now,
      };
      listCache.set(key, { expiresAt: now + LIST_TTL_MS, value: response });
      return response;
    } catch (error) {
      return {
        items: [],
        nextCursor: null,
        partial: false,
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: now,
      } satisfies PullRequestListResponse;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return await task as PullRequestListResponse;
}

export async function readPullRequestDetailForProject(input: {
  projectKey: string;
  cwd: string;
  number: number;
  runner?: GhRunner;
  now?: number;
}): Promise<PullRequestDetailResponse> {
  const now = input.now ?? Date.now();
  const key = `${input.projectKey}:${input.number}`;
  const groupKeys = ["detail", "checks", "diff", "stats"].map((group) => `${key}:${group}`);
  const cachedGroups = groupKeys.map((groupKey) => detailGroupCache.get(groupKey));
  if (cachedGroups.every((entry) => entry && entry.expiresAt > now)) {
    return cachedGroups[0]!.value;
  }
  const pending = inFlight.get(key);
  if (pending) return await pending as PullRequestDetailResponse;
  const task = (async () => {
    try {
      const result = await (input.runner ?? defaultRunner)(
        ["pr", "view", String(input.number), "--json", DETAIL_FIELDS],
        { cwd: input.cwd },
      );
      const item = toDetail(JSON.parse(result.stdout || "{}"));
      if (!item) throw new Error("GitHub returned invalid pull request detail");
      const response = { item, fetchedAt: now } satisfies PullRequestDetailResponse;
      const expiries = [DETAIL_TTL_MS, CHECKS_TTL_MS, DIFF_TTL_MS, STATS_TTL_MS];
      groupKeys.forEach((groupKey, index) => {
        detailGroupCache.set(groupKey, { expiresAt: now + (expiries[index] ?? DETAIL_TTL_MS), value: response });
      });
      return response;
    } catch (error) {
      return {
        item: null,
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: now,
      };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return await task as PullRequestDetailResponse;
}

const stateSchema = z.enum(["open", "closed", "merged", "all"]);
const involvementSchema = z.enum(["all", "author", "assignee", "mentions", "review-requested"]);
const checksSchema = z.enum(["all", "passing", "failing", "pending"]);

export async function handlePullRequestRoutes(
  ctx: ApiRouteContext,
  deps: { defaultWorkspaceRoot: string; runner?: GhRunner },
): Promise<boolean> {
  const { req, res, pathname, url, auth } = ctx;
  if (pathname !== "/api/pull-requests" && !/^\/api\/pull-requests\/\d+$/.test(pathname)) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return true;
  }

  const projectId = String(url.searchParams.get("projectId") ?? "").trim();
  if (!projectId) {
    sendJson(res, 400, { error: "projectId is required" });
    return true;
  }
  const db = getStateDatabase();
  ensureWebAuthTables(db);
  ensureWebProjectTables(db);
  const workspaceRoot = projectId === "default"
    ? deps.defaultWorkspaceRoot
    : getWebProjectRecord(db, auth.userId, projectId)?.workspaceRoot ?? "";
  if (!workspaceRoot) {
    sendJson(res, 404, { error: "Project not found" });
    return true;
  }

  const detailMatch = /^\/api\/pull-requests\/(\d+)$/.exec(pathname);
  if (detailMatch) {
    const number = Number(detailMatch[1]);
    if (!Number.isSafeInteger(number) || number < 1) {
      sendJson(res, 400, { error: "Invalid pull request number" });
      return true;
    }
    const response = await readPullRequestDetailForProject({
      projectKey: auth.userId + "\0" + projectId,
      cwd: workspaceRoot,
      number,
      runner: deps.runner,
    });
    sendJson(res, response.error ? 502 : 200, response);
    return true;
  }

  const state = stateSchema.safeParse(url.searchParams.get("state") ?? "open");
  const involvement = involvementSchema.safeParse(url.searchParams.get("involvement") ?? "all");
  const checks = checksSchema.safeParse(url.searchParams.get("checks") ?? "all");
  const labels = url.searchParams.getAll("label").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  const author = String(url.searchParams.get("author") ?? "").trim();
  const cursor = String(url.searchParams.get("cursor") ?? "").trim() || undefined;
  const refresh = url.searchParams.get("refresh") === "1";
  const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(MAX_LIMIT, Math.max(1, requestedLimit)) : 20;
  if (!state.success || !involvement.success || !checks.success) {
    sendJson(res, 400, { error: "Invalid pull request filters" });
    return true;
  }
  let response: PullRequestListResponse;
  try {
    response = await listPullRequestsForProject({
      projectKey: auth.userId + "\0" + projectId,
      cwd: workspaceRoot,
      query: {
        projectId,
        state: state.data as PullRequestState,
        involvement: involvement.data as PullRequestInvolvement,
        labels,
        author,
        checks: checks.data as PullRequestChecks,
        cursor,
        limit,
        refresh,
      },
      runner: deps.runner,
    });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  sendJson(res, 200, response);
  return true;
}

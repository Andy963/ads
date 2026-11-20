import type {
  PullRequestDetailResponse,
  PullRequestListQuery,
  PullRequestListResponse,
} from "../../../ts-server/shared/pullRequests.js";

function buildListUrl(query: PullRequestListQuery): string {
  const params = new URLSearchParams({
    projectId: query.projectId,
    state: query.state,
    involvement: query.involvement,
    checks: query.checks,
    limit: String(query.limit),
  });
  for (const label of query.labels) params.append("label", label);
  if (query.author.trim()) params.set("author", query.author.trim());
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.refresh) params.set("refresh", "1");
  return `/api/pull-requests?${params.toString()}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok && !payload.error) {
    throw new Error(`Pull request request failed (${response.status})`);
  }
  return payload;
}

export async function fetchPullRequests(query: PullRequestListQuery, signal?: AbortSignal): Promise<PullRequestListResponse> {
  const response = await fetch(buildListUrl(query), { credentials: "include", signal });
  const payload = await readJson<Partial<PullRequestListResponse>>(response);
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    partial: Boolean(payload.partial),
    ...(payload.error ? { error: payload.error } : {}),
    fetchedAt: Number(payload.fetchedAt) || Date.now(),
  };
}

export async function fetchPullRequestDetail(
  projectId: string,
  number: number,
  signal?: AbortSignal,
): Promise<PullRequestDetailResponse> {
  const params = new URLSearchParams({ projectId });
  const response = await fetch(`/api/pull-requests/${encodeURIComponent(String(number))}?${params.toString()}`, {
    credentials: "include",
    signal,
  });
  const payload = await readJson<Partial<PullRequestDetailResponse>>(response);
  return {
    item: payload.item ?? null,
    ...(payload.error ? { error: payload.error } : {}),
    fetchedAt: Number(payload.fetchedAt) || Date.now(),
  };
}

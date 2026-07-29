import { sendJson } from "../../http.js";
import type { ApiRouteContext } from "../types.js";
import type { SyncEventStore } from "../../sync/store.js";
import { mergeSyncHistory } from "../../sync/history.js";
import { buildHistoryBootstrapPayload } from "../../ws/bootstrapReplay.js";
import { resolveLaneRequest } from "../../sync/laneRequest.js";
import { resolveSharedWorkerSyncLaneKey, resolveSyncNamespace } from "../../sync/lane.js";

type SyncHistoryStore = {
  get: (key: string) => Array<{ role: string; text: string; ts: number; kind?: string }>;
};

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export async function handleSyncRoutes(
  route: ApiRouteContext,
  deps: {
    syncEventStore: SyncEventStore;
    defaultWorkspaceRoot: string;
    resolveWorkspaceRoot: (url: URL) => string;
    workerHistoryStore: SyncHistoryStore;
    plannerHistoryStore: SyncHistoryStore;
  },
): Promise<boolean> {
  if (route.pathname !== "/api/sync/events") {
    return false;
  }
  if (route.req.method !== "GET") {
    sendJson(route.res, 405, { error: "Method Not Allowed" });
    return true;
  }

  const resolved = resolveLaneRequest({
    url: route.url,
    authUserId: route.auth.userId,
    defaultWorkspaceRoot: deps.defaultWorkspaceRoot,
    resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
  });
  if (!resolved.ok) {
    sendJson(route.res, resolved.failure.status, { error: resolved.failure.error });
    return true;
  }
  const { sessionId, namespace, laneKey, laneKeys } = resolved.lane;

  const afterSeq = parsePositiveInt(route.url.searchParams.get("afterSeq"), 0);
  const limit = parsePositiveInt(route.url.searchParams.get("limit"), 500);
  const result = deps.syncEventStore.readAfterLanes({
    namespace,
    laneKeys,
    afterSeq,
    limit,
  });
  const historyStore = namespace === resolveSyncNamespace("planner")
    ? deps.plannerHistoryStore
    : deps.workerHistoryStore;
  const snapshotHistory = namespace === resolveSyncNamespace("planner")
    ? historyStore.get(laneKey)
    : mergeSyncHistory([
        historyStore.get(laneKey),
        deps.workerHistoryStore.get(resolveSharedWorkerSyncLaneKey(sessionId)),
      ]);
  const snapshot = result.truncated
    ? buildHistoryBootstrapPayload(snapshotHistory) ?? { type: "history", items: [] }
    : null;
  sendJson(route.res, 200, {
    events: result.events.map((event) => ({
      seq: event.seq,
      type: event.type,
      eventId: event.eventId ?? null,
      revision: event.revision,
      ts: event.ts,
      runId: event.runId ?? null,
      payload: event.payload,
    })),
    latestSeq: result.latestSeq,
    minAvailableSeq: result.minAvailableSeq,
    hasMore: result.hasMore,
    truncated: result.truncated,
    snapshot,
  });
  return true;
}

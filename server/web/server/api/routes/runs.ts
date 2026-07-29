import { sendJson } from "../../http.js";
import type { ApiRouteContext } from "../types.js";
import { resolveLaneRequest } from "../../sync/laneRequest.js";
import { abortInFlightHistory } from "../../ws/connectionRuntime.js";

/**
 * HTTP fallback for interrupting an in-flight run.
 *
 * The WebSocket `interrupt` frame remains the fast path. It only works while the
 * socket is open, which is exactly when it is least likely to be needed: a client
 * whose connection dropped mid-turn has no way to stop the run it started. This
 * route reaches the same `AbortController` registry over plain HTTP, so a stuck
 * turn can be stopped from a reconnecting tab, a background tab, or another device.
 *
 * The run is addressed by lane, not by a client-supplied id: the lane key is
 * derived from the authenticated user plus the workspace-validated session, so a
 * caller can only interrupt their own run.
 */
export async function handleRunRoutes(
  route: ApiRouteContext,
  deps: {
    defaultWorkspaceRoot: string;
    resolveWorkspaceRoot: (url: URL) => string;
    interruptControllers: Map<string, AbortController>;
    promptRunEpochs?: Map<string, number>;
  },
): Promise<boolean> {
  if (route.pathname !== "/api/runs/interrupt") {
    return false;
  }
  if (route.req.method !== "POST") {
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

  // Aborting is enough: the run's own error/result frames flow through the normal
  // broadcast path, which persists them to the sync log for every connected tab.
  const interrupted = abortInFlightHistory({
    interruptControllers: deps.interruptControllers,
    promptRunEpochs: deps.promptRunEpochs,
    historyKey: resolved.lane.laneKey,
  });

  sendJson(route.res, 200, { ok: true, interrupted });
  return true;
}
